// HTTP probe for listen-based samples that honor PORT (or use listen(port)).
// Entity-only samples are covered by projects-smoke.test.mjs load tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');

async function freePort() {
  const s = createServer();
  s.listen(0);
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * Spawn sample with PORT=port, wait until /health answers (poll), then return
 * status. Always SIGKILL the child in finally.
 */
async function probeWithPort(relFile, { path = '/health', timeoutMs = 8000 } = {}) {
  const port = await freePort();
  const cwd = mkdtempSync(join(tmpdir(), 'ex-http-'));
  const child = spawn('node', [join(REPO, relFile)], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode != null && child.exitCode !== 0) {
        throw new Error(`${relFile} exited ${child.exitCode}:\n${out}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(500),
        });
        const body = await res.text();
        return { status: res.status, body, port, out };
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(
      `${relFile} no HTTP on :${port}${path} within ${timeoutMs}ms\nlast: ${lastErr}\n---\n${out}`,
    );
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    // Don't hang forever waiting for exit
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }
}

test('HTTP probe: examples/minimal-note.mjs /health is non-5xx', { concurrency: false }, async () => {
  const r = await probeWithPort('examples/minimal-note.mjs', { path: '/health' });
  assert.ok(r.status < 500, `status ${r.status}: ${r.body}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /ok/i);
});

test('HTTP probe: examples/minimal-note.mjs GET /notes is non-5xx', { concurrency: false }, async () => {
  const r = await probeWithPort('examples/minimal-note.mjs', { path: '/notes' });
  assert.ok(r.status < 500, `status ${r.status}: ${r.body}`);
  assert.equal(r.status, 200);
});

test('HTTP probe: projects/note.mjs /health when PORT set', { concurrency: false }, async () => {
  // note.mjs: workbench({db}).mount(...).listen() — uses config.port from PORT env
  const r = await probeWithPort('projects/note.mjs', { path: '/health' });
  assert.ok(r.status < 500, `status ${r.status}: ${r.body}\n${r.out}`);
});

test('HTTP probe: projects/todo-app.mjs /health when PORT set', { concurrency: false }, async () => {
  // todo-app.listen({ principalOf, onListening }) — port from config / PORT
  const r = await probeWithPort('projects/todo-app.mjs', { path: '/health' });
  assert.ok(r.status < 500, `status ${r.status}: ${r.body}\n${r.out}`);
});

test('HTTP probe: projects/chat/server.mjs /health when PORT set', { concurrency: false }, async () => {
  const r = await probeWithPort('projects/chat/server.mjs', { path: '/health' });
  assert.ok(r.status < 500, `status ${r.status}: ${r.body}\n${r.out}`);
});

test('HTTP probe: projects/gdoc.mjs /health when PORT set', { concurrency: false }, async () => {
  const r = await probeWithPort('projects/gdoc.mjs', { path: '/health' });
  assert.ok(r.status < 500, `status ${r.status}: ${r.body}\n${r.out}`);
});
