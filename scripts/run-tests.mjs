import { closeSync, globSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_FAILURE_CHARS = 12_000;
const MAX_FAILURE_LINES = 80;
const keepLog = process.env.WORKBENCH_KEEP_TEST_LOGS === '1';
const logDirectory = mkdtempSync(join(tmpdir(), 'workbench-test-'));
const logPath = join(logDirectory, 'node-test.log');
const output = openSync(logPath, 'w');
const started = performance.now();
const testFiles = globSync('test/**/*.test.mjs').filter((file) => !file.startsWith('test/browser/'));

const child = spawn(
  process.execPath,
  ['--test', '--test-force-exit', '--test-reporter=dot', '--test-timeout=30000', ...process.argv.slice(2), ...testFiles],
  { cwd: process.cwd(), env: process.env, stdio: ['ignore', output, output] },
);

const result = await new Promise((resolve) => {
  child.once('error', (error) => resolve({ error }));
  child.once('close', (code, signal) => resolve({ code, signal }));
});
closeSync(output);

const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (result.code === 0 && !result.error) {
  console.log(`PASS node --test (${seconds}s)`);
  if (keepLog) {
    console.log(`Full log: ${logPath}`);
  } else {
    rmSync(logDirectory, { recursive: true, force: true });
  }
  process.exitCode = 0;
} else {
  console.error(`FAIL node --test (${seconds}s${result.signal ? `, signal ${result.signal}` : ''})`);
  if (result.error) console.error(result.error.message);

  const log = readFileSync(logPath, 'utf8');
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
}
