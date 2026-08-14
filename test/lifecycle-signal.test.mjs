import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function signalChild(shutdownSource) {
  const source = `
    import { installGracefulShutdown } from './build/lifecycle.mjs';
    const app = { shutdown: ${shutdownSource} };
    installGracefulShutdown(app);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForReady(child) {
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes('ready\n')) return;
  }
  throw new Error('lifecycle child exited before it became ready');
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('a rejected application shutdown cannot strand process signal handling', async () => {
  const child = signalChild(`() => Promise.reject(new Error('cleanup failed'))`);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitForReady(child);
  const exited = waitForExit(child);

  child.kill('SIGTERM');

  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.match(stderr, /cleanup failed/);
});

test('a synchronous application shutdown failure cannot strand signal handling', async () => {
  const child = signalChild(`() => { throw new Error('cleanup threw'); }`);
  await waitForReady(child);
  const exited = waitForExit(child);

  child.kill('SIGTERM');

  assert.deepEqual(await exited, { code: 0, signal: null });
});

test('a second termination signal force-exits a stuck graceful drain', async () => {
  const child = signalChild(`() => new Promise(() => {})`);
  await waitForReady(child);
  const exited = waitForExit(child);

  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 25));
  child.kill('SIGTERM');

  assert.deepEqual(await exited, { code: 1, signal: null });
});

test('a broken stdio pipe exits the process instead of spinning on repeated EPIPE errors', async () => {
  // A write to a dead pipe surfaces as an async EPIPE uncaughtException; the
  // trap would try to log it to the same broken stderr, raising EPIPE again —
  // an infinite full-CPU loop. The trap must exit instead. (Regression: an
  // orphaned child whose parent died burned 100% CPU forever.)
  const source = `
    import { installGracefulShutdown } from './build/lifecycle.mjs';
    installGracefulShutdown({ shutdown: async () => {} });
    setTimeout(() => process.stdout.write('ping\\n'), 50);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Close our read ends so every child write raises EPIPE.
  child.stdout.destroy();
  child.stderr.destroy();

  const { code } = await waitForExit(child);

  assert.equal(code, 1);
});

test('a direct shutdown keeps its hook deadline alive until a hung hook is abandoned', async () => {
  const source = `
    import { prepareGracefulShutdown } from './build/lifecycle.mjs';
    const app = {};
    prepareGracefulShutdown(app);
    app.onShutdown('hung', () => new Promise(() => {}), { timeoutMs: 25 });
    await app.shutdown();
    process.stdout.write('shutdown-settled');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });

  const { code } = await waitForExit(child);

  assert.equal(code, 0);
  assert.equal(stdout, 'shutdown-settled');
});
