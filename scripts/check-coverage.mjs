// Check that test coverage meets the minimum threshold.
// Usage: node scripts/check-coverage.mjs <threshold>

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_FAILURE_CHARS = 12_000;
const MAX_FAILURE_LINES = 80;
const keepLog = process.env.WORKBENCH_KEEP_TEST_LOGS === '1';

const threshold = Number.parseFloat(process.argv[2] ?? '85');
if (Number.isNaN(threshold)) {
  console.error('Usage: node scripts/check-coverage.mjs <threshold>');
  process.exit(2);
}

const logDirectory = mkdtempSync(join(tmpdir(), 'workbench-coverage-'));
const logPath = join(logDirectory, 'node-test.log');
const output = openSync(logPath, 'w');
const started = performance.now();
const child = spawn(process.execPath, [
  '--experimental-test-coverage',
  '--test',
  '--test-force-exit',
  '--test-timeout=30000',
  ...process.argv.slice(3),
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', output, output],
});

const result = await new Promise((resolve) => {
  child.once('error', (error) => resolve({ error }));
  child.once('close', (code, signal) => resolve({ code, signal }));
});
closeSync(output);

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const log = readFileSync(logPath, 'utf8');
if (result.code !== 0 || result.error) {
  console.error(`FAIL node --experimental-test-coverage --test (${seconds}s${result.signal ? `, signal ${result.signal}` : ''})`);
  if (result.error) console.error(result.error.message);

  const failureStart = log.search(/failed tests:/i);
  const relevant = failureStart === -1 ? log : log.slice(failureStart);
  const excerpt = relevant.split('\n').slice(0, MAX_FAILURE_LINES).join('\n').slice(0, MAX_FAILURE_CHARS);
  if (excerpt) console.error(excerpt);
  if (excerpt.length < relevant.length) console.error('... failure output truncated; inspect the full log for all failures.');
  console.error(`Full log: ${logPath}`);

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
} else {
  const match = log.match(/^ℹ\s+all files\s+\|\s+([\d.]+)\s/m);
  if (!match) {
    console.error('Could not find "all files" coverage line in test output.');
    console.error(`Full log: ${logPath}`);
    process.exitCode = 1;
  } else {
    const pct = Number.parseFloat(match[1]);
    console.log(`Coverage: ${pct.toFixed(2)}% (threshold: ${threshold}%)`);

    if (pct < threshold) {
      console.error(`Coverage ${pct.toFixed(2)}% is below threshold ${threshold}%.`);
      console.error(`Full log: ${logPath}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS node --experimental-test-coverage --test (${seconds}s)`);
      if (keepLog) {
        console.log(`Full log: ${logPath}`);
      } else {
        rmSync(logDirectory, { recursive: true, force: true });
      }
      process.exitCode = 0;
    }
  }
}
