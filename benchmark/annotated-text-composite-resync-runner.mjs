// Orchestrates the owner-ratified W1a acceptance scenarios in fresh processes.
// Every child starts only after an immediate process-list isolation check.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const SCENARIOS = ['server-peak', 'client-peak', 'retained-growth', 'initial', 'fallback'];
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
  stoppedBefore: null,
};

for (const scenario of SCENARIOS) {
  const isolation = isolationSnapshot();
  aggregate.isolation[scenario] = isolation;
  if (isolation.matches.length > 0) {
    aggregate.stoppedBefore = scenario;
    aggregate.failure = `isolation check found active workers before ${scenario}`;
    break;
  }
  const child = spawnSync(process.execPath, ['--expose-gc', 'benchmark/annotated-text-composite-resync.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, ANNOTATED_TEXT_BENCH_SCENARIO: scenario },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) {
    aggregate.stoppedBefore = scenario;
    aggregate.failure = `${scenario} process exited ${child.status}`;
    aggregate.scenarios[scenario] = { stderr: child.stderr, stdout: child.stdout };
    break;
  }
  const report = JSON.parse(child.stdout);
  report.stderr = child.stderr;
  aggregate.scenarios[scenario] = report;
  if (report.thresholdNotes?.length) {
    aggregate.failure = `${scenario} failed: ${report.thresholdNotes.join('; ')}`;
    aggregate.stoppedBefore = scenario;
    break;
  }
}

aggregate.passed = !aggregate.failure && Object.keys(aggregate.scenarios).length === SCENARIOS.length;
console.log(JSON.stringify(aggregate, null, 2));
if (!aggregate.passed) process.exitCode = 1;
