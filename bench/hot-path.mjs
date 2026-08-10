// Repeatable performance harness for the workbench HTTP CRUD hot path.
//
// The benchmark exercises the real node:http transport with both default-on
// authorization layers engaged: the route gate and the owner-scoped row grant's
// SQL scope plus runtime capability check. It has no package dependencies.
//
// Normal output is exactly one stable JSON object on stdout. Progress and
// diagnostics go to stderr, so a report can be captured directly:
//
//   node bench/hot-path.mjs > /tmp/workbench-benchmark.json
//
// See docs/performance-benchmarks.md for the workload definitions and compare
// workflow.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import inspector from 'node:inspector';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import workbench, { entity } from '../src/internal.mjs';
import {
  text, number, boolean, ref, scope, grant, read, write, subscribe, principal,
} from '../src/index.mjs';

const SCHEMA_VERSION = 1;
const BENCHMARK_NAME = 'http-crud-hot-path';
const DEFAULT_SAMPLES = 5;
const DEFAULT_MAX_REGRESSION_PCT = 10;
const DEFAULT_PROFILE_PATH = 'bench/hot-path.cpuprofile';
const METRICS = Object.freeze([
  'create_ops_s',
  'read_ops_s',
  'list_ops_s',
  'update_ops_s',
  'composite_ops_s',
]);

// The three sizes keep the request shape constant while increasing the amount
// of live database state. A fresh app is used for each sample, so setup and
// teardown do not contaminate the timed HTTP phases.
const WORKLOADS = Object.freeze({
  small: Object.freeze({
    warmup: 50,
    create: 200,
    read: 200,
    list: 50,
    update: 200,
    listSeed: 25,
  }),
  medium: Object.freeze({
    warmup: 100,
    create: 600,
    read: 600,
    list: 120,
    update: 600,
    listSeed: 60,
  }),
  large: Object.freeze({
    warmup: 200,
    create: 1200,
    read: 1200,
    list: 240,
    update: 1200,
    listSeed: 120,
  }),
});

const DEFAULT_SIZES = Object.freeze(Object.keys(WORKLOADS));
const me = principal({ type: 'user', id: 'bench-user' });

function log(message) {
  process.stderr.write(`${message}\n`);
}

function usage() {
  return `Usage: node bench/hot-path.mjs [options]

Options:
  --sizes <names>             Comma-separated sizes: small,medium,large
                              (default: all three)
  --samples <count>           Samples per size (default: ${DEFAULT_SAMPLES})
  --compare <file>            Compare current medians with a JSON report
  --max-regression-pct <pct>  Allowed median slowdown per metric (default: ${DEFAULT_MAX_REGRESSION_PCT})
  --profile [file]             Write a V8 CPU profile (default: ${DEFAULT_PROFILE_PATH})
  --help                      Show this help

Output is one JSON object on stdout; progress is written to stderr.`;
}

function optionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined && inlineValue !== '') return { value: inlineValue, index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return { value: next, index: index + 1 };
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function percentage(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    sizes: [...DEFAULT_SIZES],
    samples: DEFAULT_SAMPLES,
    comparePath: null,
    maxRegressionPct: DEFAULT_MAX_REGRESSION_PCT,
    profilePath: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    if (name === '--help' || name === '-h') {
      options.help = true;
      continue;
    }
    if (name === '--sizes') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      const sizes = selected.value.split(',').map((value) => value.trim()).filter(Boolean);
      if (sizes.length === 0) throw new Error('--sizes must name at least one workload');
      for (const size of sizes) {
        if (!Object.hasOwn(WORKLOADS, size)) {
          throw new Error(`unknown workload '${size}' (choose ${DEFAULT_SIZES.join(', ')})`);
        }
      }
      if (new Set(sizes).size !== sizes.length) throw new Error('--sizes cannot contain duplicates');
      options.sizes = sizes;
      continue;
    }
    if (name === '--samples') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      options.samples = positiveInteger(selected.value, name);
      if (options.samples > 100) throw new Error('--samples must be at most 100');
      continue;
    }
    if (name === '--compare') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      options.comparePath = selected.value;
      continue;
    }
    if (name === '--max-regression-pct') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      options.maxRegressionPct = percentage(selected.value, name);
      continue;
    }
    if (name === '--profile') {
      if (inlineValue !== undefined && inlineValue !== '') {
        options.profilePath = inlineValue;
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          options.profilePath = next;
          index += 1;
        } else {
          options.profilePath = DEFAULT_PROFILE_PATH;
        }
      }
      continue;
    }
    throw new Error(`unknown option '${argument}'`);
  }

  return options;
}

function ownedNote() {
  return entity('Note', {
    title: text(),
    body: text(),
    count: number(),
    done: boolean(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

function ownedFeed() {
  return entity('Feed', {
    title: text(),
    body: text(),
    count: number(),
    done: boolean(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function request(origin, path, { method = 'GET', body, expect } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${origin}${path}`, init);
  } catch (error) {
    throw new Error(`request ${method} ${path} threw: ${error?.message ?? error}`);
  }

  if (expect !== undefined && response.status !== expect) {
    let detail = '';
    try { detail = await response.text(); } catch { /* best-effort error detail */ }
    throw new Error(
      `${method} ${path} expected ${expect} got ${response.status}`
      + (detail ? `: ${detail.slice(0, 200)}` : ''),
    );
  }
  return response;
}

async function createPass(origin, count, ids) {
  for (let index = 0; index < count; index += 1) {
    const response = await request(origin, '/notes', {
      method: 'POST',
      body: { title: `t${index}`, body: `b${index}`, count: index, done: index % 2 === 0 },
      expect: 201,
    });
    const row = await response.json();
    if (!row || row.id == null) throw new Error('create returned no id');
    ids.push(row.id);
  }
}

async function readPass(origin, count, ids) {
  for (let index = 0; index < count; index += 1) {
    const id = ids[index % ids.length];
    const response = await request(origin, `/notes/${id}`, { expect: 200 });
    await response.json();
  }
}

async function listPass(origin, count) {
  for (let index = 0; index < count; index += 1) {
    const response = await request(origin, '/feed', { expect: 200 });
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('list did not return an array');
  }
}

async function updatePass(origin, count, ids) {
  for (let index = 0; index < count; index += 1) {
    const id = ids[index % ids.length];
    const response = await request(origin, `/notes/${id}`, {
      method: 'PATCH',
      body: { count: index, done: index % 2 === 1, title: `u${index}` },
      expect: 200,
    });
    await response.json();
  }
}

async function timed(count, run) {
  const started = process.hrtime.bigint();
  await run();
  const elapsedNs = Number(process.hrtime.bigint() - started);
  if (!Number.isFinite(elapsedNs) || elapsedNs <= 0) throw new Error('invalid benchmark duration');
  return (count * 1e9) / elapsedNs;
}

function geometricMean(values) {
  const logSum = values.reduce((sum, value) => sum + Math.log(value), 0);
  return Math.exp(logSum / values.length);
}

function round(value) {
  const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function summarize(values) {
  if (values.length === 0) throw new Error('cannot summarize an empty sample set');
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
    : 0;
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const standardDeviation = Math.sqrt(variance);

  return {
    sample_ops_s: values.map(round),
    min_ops_s: round(sorted[0]),
    median_ops_s: round(median),
    mean_ops_s: round(mean),
    stddev_ops_s: round(standardDeviation),
    relative_stddev_pct: round(mean === 0 ? 0 : (standardDeviation / mean) * 100),
    max_ops_s: round(sorted[sorted.length - 1]),
  };
}

function operationsFor(config) {
  return {
    warmup: config.warmup,
    create: config.create,
    read: config.read,
    list: config.list,
    update: config.update,
    list_seed: config.listSeed,
  };
}

async function runSample(config) {
  const db = new DatabaseSync(':memory:');
  let app;
  try {
    app = workbench({ db, log: { level: 'warn' } });
    app.mount('/notes', ownedNote());
    app.mount('/feed', ownedFeed());
    app.listen(0, { principalOf: () => me });
    await app.ready;

    const address = app.httpServer.address();
    if (!address || typeof address === 'string' || address.port == null) {
      throw new Error('benchmark server did not expose a TCP port');
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const insert = db.prepare(
      'INSERT INTO Feed (id, title, body, count, done, owner) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let index = 0; index < config.listSeed; index += 1) {
      insert.run(randomUUID(), `feed${index}`, `body${index}`, index, index % 2, 'bench-user');
    }

    const check = await request(origin, '/feed', { expect: 200 });
    const seeded = await check.json();
    if (!Array.isArray(seeded) || seeded.length !== config.listSeed) {
      throw new Error(
        `list sanity check: expected ${config.listSeed} rows, got ${Array.isArray(seeded) ? seeded.length : typeof seeded}`,
      );
    }

    // Warm the same request shapes that are timed. Warmup rows remain in the
    // database intentionally: the measured phases should see a warmed, growing
    // table rather than an empty-table special case.
    const warmIds = [];
    for (let index = 0; index < config.warmup; index += 1) {
      await createPass(origin, 1, warmIds);
      await readPass(origin, 1, warmIds);
      await listPass(origin, 1);
    }

    const ids = [];
    const createOps = await timed(config.create, () => createPass(origin, config.create, ids));
    if (ids.length === 0) throw new Error('create phase produced no ids');
    const readOps = await timed(config.read, () => readPass(origin, config.read, ids));
    const listOps = await timed(config.list, () => listPass(origin, config.list));
    const updateOps = await timed(config.update, () => updatePass(origin, config.update, ids));

    const phaseOps = [createOps, readOps, listOps, updateOps];
    return {
      create_ops_s: createOps,
      read_ops_s: readOps,
      list_ops_s: listOps,
      update_ops_s: updateOps,
      composite_ops_s: geometricMean(phaseOps),
    };
  } finally {
    if (app) await app.shutdown();
    db.close();
  }
}

async function runWorkload(name, config, samples) {
  log(`${name}: ${samples} samples`);
  const values = Object.fromEntries(METRICS.map((metric) => [metric, []]));
  for (let sample = 1; sample <= samples; sample += 1) {
    const result = await runSample(config);
    for (const metric of METRICS) values[metric].push(result[metric]);
    log(
      `  sample ${sample}/${samples}: `
      + `create ${result.create_ops_s.toFixed(0)} · `
      + `read ${result.read_ops_s.toFixed(0)} · `
      + `list ${result.list_ops_s.toFixed(0)} · `
      + `update ${result.update_ops_s.toFixed(0)} ops/s`,
    );
  }

  const metrics = {};
  for (const metric of METRICS) metrics[metric] = summarize(values[metric]);
  return {
    name,
    operations: operationsFor(config),
    metrics,
  };
}

function inspectorPost(session, method) {
  return new Promise((resolveResult, reject) => {
    session.post(method, (error, result) => {
      if (error) reject(error);
      else resolveResult(result);
    });
  });
}

async function startCpuProfile(profilePath) {
  const outputPath = resolve(profilePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  const session = new inspector.Session();
  session.connect();
  try {
    await inspectorPost(session, 'Profiler.enable');
    await inspectorPost(session, 'Profiler.start');
  } catch (error) {
    session.disconnect();
    throw new Error(`could not start CPU profiler: ${error?.message ?? error}`);
  }

  return async () => {
    let stopError;
    try {
      const result = await inspectorPost(session, 'Profiler.stop');
      if (!result?.profile) throw new Error('CPU profiler returned no profile');
      writeFileSync(outputPath, JSON.stringify(result.profile));
    } catch (error) {
      stopError = error;
    } finally {
      try { await inspectorPost(session, 'Profiler.disable'); } catch { /* best effort */ }
      session.disconnect();
    }
    if (stopError) throw new Error(`could not write CPU profile: ${stopError?.message ?? stopError}`);
  };
}

function readBaseline(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`could not read baseline '${path}': ${error?.message ?? error}`);
  }
  if (!value || value.schema_version !== SCHEMA_VERSION || value.benchmark !== BENCHMARK_NAME) {
    throw new Error(`baseline '${path}' is not a ${BENCHMARK_NAME} v${SCHEMA_VERSION} report`);
  }
  return value;
}

function compareReports(current, baseline, baselinePath, maxRegressionPct) {
  const baselineByName = new Map((baseline.workloads ?? []).map((workload) => [workload.name, workload]));
  const checks = [];

  for (const workload of current.workloads) {
    const previous = baselineByName.get(workload.name);
    if (!previous) throw new Error(`baseline has no '${workload.name}' workload`);
    if (JSON.stringify(previous.operations) !== JSON.stringify(workload.operations)) {
      throw new Error(`baseline '${workload.name}' workload operations do not match current run`);
    }

    for (const metric of METRICS) {
      const baselineMedian = previous.metrics?.[metric]?.median_ops_s;
      const currentMedian = workload.metrics?.[metric]?.median_ops_s;
      if (!Number.isFinite(baselineMedian) || baselineMedian <= 0) {
        throw new Error(`baseline '${workload.name}' metric '${metric}' has no positive median`);
      }
      if (!Number.isFinite(currentMedian) || currentMedian <= 0) {
        throw new Error(`current '${workload.name}' metric '${metric}' has no positive median`);
      }

      const changePct = ((currentMedian - baselineMedian) / baselineMedian) * 100;
      const regressionPct = Math.max(0, -changePct);
      checks.push({
        workload: workload.name,
        metric,
        baseline_median_ops_s: baselineMedian,
        current_median_ops_s: currentMedian,
        change_pct: round(changePct),
        regression_pct: round(regressionPct),
        passed: regressionPct <= maxRegressionPct,
      });
    }
  }

  return {
    baseline: baselinePath,
    max_regression_pct: maxRegressionPct,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const stopProfiler = options.profilePath ? await startCpuProfile(options.profilePath) : null;
  let report;
  try {
    const workloads = [];
    for (const name of options.sizes) {
      workloads.push(await runWorkload(name, WORKLOADS[name], options.samples));
    }
    report = {
      schema_version: SCHEMA_VERSION,
      benchmark: BENCHMARK_NAME,
      samples: options.samples,
      workloads,
      profile: options.profilePath
        ? { enabled: true, path: options.profilePath }
        : { enabled: false },
      comparison: null,
    };
  } finally {
    if (stopProfiler) await stopProfiler();
  }

  if (options.comparePath) {
    const baseline = readBaseline(options.comparePath);
    report.comparison = compareReports(
      report,
      baseline,
      options.comparePath,
      options.maxRegressionPct,
    );
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.comparison && !report.comparison.passed) process.exitCode = 1;
}

main().catch((error) => {
  const message = error?.message ?? String(error);
  log(`benchmark failed: ${message}`);
  process.stdout.write(`${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    benchmark: BENCHMARK_NAME,
    error: message,
  })}\n`);
  process.exitCode = 1;
});
