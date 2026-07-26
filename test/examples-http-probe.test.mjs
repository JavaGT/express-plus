// HTTP probe for listen-based samples that honor PORT (or use listen(port)).
// Entity-only samples are covered by projects-smoke.test.mjs load tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const OUTPUT_LIMIT = 16_384;
const CLOSE_TIMEOUT_MS = 1000;

function appendOutput(output, chunk) {
  if (output.length >= OUTPUT_LIMIT) return output;
  const remaining = OUTPUT_LIMIT - output.length;
  const text = chunk.toString();
  return output + text.slice(0, remaining);
}

function diagnostic(...parts) {
  return parts.join('').slice(0, OUTPUT_LIMIT);
}

function waitForChildClose(child) {
  return new Promise((resolveFn) => {
    child.once('close', resolveFn);
  });
}

async function cleanupChild(child, childClosed, cwd) {
  try {
    if (process.platform === 'win32') {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    } else if (child.pid) {
      // Detached children lead a process group, including descendants holding stdio.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
    } else {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await Promise.race([
      childClosed,
      new Promise((resolveFn) => setTimeout(resolveFn, CLOSE_TIMEOUT_MS)),
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

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
 * status. Always terminate the child and remove its temporary cwd in finally.
 */
async function probeWithPort(relFile, { path = '/health', timeoutMs = 8000 } = {}) {
  const port = await freePort();
  const cwd = mkdtempSync(join(tmpdir(), 'ex-http-'));
  const child = spawn('node', [join(REPO, relFile)], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childClosed = waitForChildClose(child);
  let out = '';
  child.stdout.on('data', (d) => { out = appendOutput(out, d); });
  child.stderr.on('data', (d) => { out = appendOutput(out, d); });

  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode != null && child.exitCode !== 0) {
        throw new Error(diagnostic(`${relFile} exited ${child.exitCode}:\n`, out));
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
      diagnostic(`${relFile} no HTTP on :${port}${path} within ${timeoutMs}ms\nlast: ${lastErr}\n---\n`, out),
    );
  } finally {
    await cleanupChild(child, childClosed, cwd);
  }
}

test('HTTP probe: examples/minimal-note.mjs /health is non-5xx', { concurrency: false }, async () => {
  const r = await probeWithPort('examples/minimal-note.mjs', { path: '/health' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: `, r.body));
  assert.equal(r.status, 200);
  assert.match(r.body, /ok/i);
});

test('HTTP probe: examples/minimal-note.mjs GET /notes is non-5xx', { concurrency: false }, async () => {
  const r = await probeWithPort('examples/minimal-note.mjs', { path: '/notes' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: `, r.body));
  assert.equal(r.status, 200);
});

test('HTTP probe: projects/note.mjs /health when PORT set', { concurrency: false }, async () => {
  // note.mjs: workbench({db}).mount(...).listen() — uses config.port from PORT env
  const r = await probeWithPort('projects/note.mjs', { path: '/health' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: ${r.body}\n`, r.out));
});

test('HTTP probe: projects/todo-app.mjs /health when PORT set', { concurrency: false }, async () => {
  // todo-app.listen({ principalOf, onListening }) — port from config / PORT
  const r = await probeWithPort('projects/todo-app.mjs', { path: '/health' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: ${r.body}\n`, r.out));
});

test('HTTP probe: projects/chat/server.mjs /health when PORT set', { concurrency: false }, async () => {
  const r = await probeWithPort('projects/chat/server.mjs', { path: '/health' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: ${r.body}\n`, r.out));
});

test('HTTP probe: projects/gdoc.mjs /health when PORT set', { concurrency: false }, async () => {
  const r = await probeWithPort('projects/gdoc.mjs', { path: '/health' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: ${r.body}\n`, r.out));
});

test('HTTP probe: projects/app.mjs /health when PORT set (listen(callback) overload)', { concurrency: false }, async () => {
  // app.mjs uses listen(() => log) — must bind app.config.port (from PORT), not
  // treat the function as the port argument.
  const r = await probeWithPort('projects/app.mjs', { path: '/health' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: ${r.body}\n`, r.out));
  assert.equal(r.status, 200);
});

test('HTTP probe: projects/todo.mjs /health when PORT set', { concurrency: false }, async () => {
  const r = await probeWithPort('projects/todo.mjs', { path: '/health' });
  assert.ok(r.status < 500, diagnostic(`status ${r.status}: ${r.body}\n`, r.out));
});
