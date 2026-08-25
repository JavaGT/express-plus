// Orchestrates the owner-ratified W1a acceptance scenarios in fresh processes.
// Every child starts only after an immediate process-list isolation check.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  evaluateW1aScaling, W1A_LATENCY_GATES, W1A_SCALING_WORDS,
} from './annotated-text-composite-resync-contract.mjs';

const SCENARIOS = [
  { key: 'server-peak', scenario: 'server-peak' },
  { key: 'client-peak', scenario: 'client-peak' },
  { key: 'retained-growth', scenario: 'retained-growth' },
  { key: 'scaling-9000', scenario: 'initial', words: 9_000 },
  { key: 'scaling-18000', scenario: 'initial', words: 18_000 },
  { key: 'initial', scenario: 'initial', words: 36_000 },
  { key: 'fallback', scenario: 'fallback', words: 36_000 },
];
const WORKER_PATTERN = /vitest|svelte-check|node --test|annotated-text-composite-resync(?:-runner)?\.mjs|benchmark:annotated-text/i;

function ancestors() {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const parentByPid = new Map(rows.map(([pid, ppid]) => [pid, ppid]));
  const own = new Set([process.pid]);
  let current = process.pid;
  while (parentByPid.has(current)) {
    current = parentByPid.get(current);
    if (!current || own.has(current)) break;
    own.add(current);
  }
  return own;
}

function isolationSnapshot() {
  const processList = execFileSync('ps', ['-Ao', 'pid=,ppid=,pcpu=,rss=,etime=,command='], { encoding: 'utf8' });
  const own = ancestors();
  const matches = processList.split('\n').filter((line) => {
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    return !own.has(pid) && WORKER_PATTERN.test(line);
  });
  return {
    capturedAt: new Date().toISOString(),
    uptime: execFileSync('uptime', { encoding: 'utf8' }).trim(),
    processList,
    processListSha256: createHash('sha256').update(processList).digest('hex'),
    matches,
  };
}

const aggregate = {
  recordedAt: new Date().toISOString(),
  commit: process.env.ANNOTATED_TEXT_BENCH_COMMIT ?? null,
  command: 'pnpm benchmark:annotated-text-composite-resync:acceptance',
  scenarios: {},
  isolation: {},
  gates: {
    initialBootstrap: { status: 'pending', limitMs: W1A_LATENCY_GATES.initialBootstrapP95Ms },
    forcedFallbackCycle: { status: 'pending', limitMs: W1A_LATENCY_GATES.forcedFallbackCycleP95Ms },
    interactiveFold: {
      status: 'skipped',
      limitMs: W1A_LATENCY_GATES.interactiveFoldP95Ms,
      activates: 'W1c',
      reason: 'interactive fold delivery is not implemented until W1c',
    },
    scaling: { status: 'pending' },
  },
  stoppedBefore: null,
};
const clientInputDirectory = mkdtempSync(join(tmpdir(), 'workbench-w1a-client-'));

try {
for (const entry of SCENARIOS) {
  const { key, scenario, words } = entry;
  let isolation = isolationSnapshot();
  aggregate.isolation[key] = isolation;
  if (isolation.matches.length > 0) {
    aggregate.stoppedBefore = key;
    aggregate.failure = `isolation check found active workers before ${key}`;
    break;
  }
  if (scenario === 'client-peak') {
    const preparation = spawnSync(process.execPath, ['benchmark/annotated-text-composite-resync.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, ANNOTATED_TEXT_BENCH_SCENARIO: 'client-prepare', ANNOTATED_TEXT_BENCH_CLIENT_INPUT: clientInputDirectory },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (preparation.status !== 0) {
      aggregate.stoppedBefore = scenario;
      aggregate.failure = `client-peak preparation exited ${preparation.status}`;
      aggregate.scenarios[scenario] = { stderr: preparation.stderr, stdout: preparation.stdout };
      break;
    }
    isolation = isolationSnapshot();
    aggregate.isolation[key] = isolation;
    if (isolation.matches.length > 0) {
      aggregate.stoppedBefore = key;
      aggregate.failure = `isolation check found active workers before ${key}`;
      break;
    }
  }
  const child = spawnSync(process.execPath, ['--expose-gc', 'benchmark/annotated-text-composite-resync.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANNOTATED_TEXT_BENCH_SCENARIO: scenario,
      ANNOTATED_TEXT_BENCH_CLIENT_INPUT: clientInputDirectory,
      ...(words ? { ANNOTATED_TEXT_BENCH_WORDS: String(words) } : {}),
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) {
    aggregate.stoppedBefore = key;
    aggregate.failure = `${key} process exited ${child.status}`;
    aggregate.scenarios[key] = { stderr: child.stderr, stdout: child.stdout };
    break;
  }
  const report = JSON.parse(child.stdout);
  report.stderr = child.stderr;
  aggregate.scenarios[key] = report;
  if (report.thresholdNotes?.length) {
    if (key === 'initial') {
      aggregate.gates.initialBootstrap = {
        status: 'failed', limitMs: W1A_LATENCY_GATES.initialBootstrapP95Ms, measuredP95Ms: report.projections?.endToEndP95Ms,
      };
    }
    if (key === 'fallback') {
      aggregate.gates.forcedFallbackCycle = {
        status: 'failed', limitMs: W1A_LATENCY_GATES.forcedFallbackCycleP95Ms, measuredP95Ms: report.projections?.endToEndP95Ms,
      };
    }
    aggregate.failure = `${key} failed: ${report.thresholdNotes.join('; ')}`;
    aggregate.stoppedBefore = key;
    break;
  }
  if (key === 'initial') {
    aggregate.gates.initialBootstrap = {
      status: 'passed', limitMs: W1A_LATENCY_GATES.initialBootstrapP95Ms, measuredP95Ms: report.projections.endToEndP95Ms,
    };
    const scaling = evaluateW1aScaling(new Map(W1A_SCALING_WORDS.map((fixtureWords) => [
      fixtureWords,
      aggregate.scenarios[fixtureWords === 36_000 ? 'initial' : `scaling-${fixtureWords}`].projections.endToEndP95Ms,
    ])));
    aggregate.gates.scaling = { status: scaling.passed ? 'passed' : 'failed', ...scaling };
    if (!scaling.passed) {
      aggregate.failure = 'initial bootstrap scaling check failed';
      aggregate.stoppedBefore = 'fallback';
      break;
    }
  }
  if (key === 'fallback') {
    aggregate.gates.forcedFallbackCycle = {
      status: 'passed', limitMs: W1A_LATENCY_GATES.forcedFallbackCycleP95Ms, measuredP95Ms: report.projections.endToEndP95Ms,
    };
  }
}
} finally {
  rmSync(clientInputDirectory, { recursive: true, force: true });
}

aggregate.passed = !aggregate.failure && Object.keys(aggregate.scenarios).length === SCENARIOS.length;
console.log(JSON.stringify(aggregate, null, 2));
if (!aggregate.passed) process.exitCode = 1;
