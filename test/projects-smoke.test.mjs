// projects-smoke.test.mjs — every exemplar under projects/** and examples/**
// loads cleanly (no KNOWN_UNRESOLVED allowlist).
//
// Spawn `node <file>` with cwd = a fresh temp dir (samples create *.db / .blobs
// relative to cwd). Success = exit 0 quickly OR still alive after the load
// window (server started) — then killed. Failure = non-zero exit within the
// window; stderr is in the assertion.
//
// Sequential: several samples hardcode port 3000.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const SAMPLE_ROOTS = [join(REPO, 'projects'), join(REPO, 'examples')];
const LOAD_WINDOW_MS = 1500;
const OUTPUT_LIMIT = 16_384;
const CLOSE_TIMEOUT_MS = 1000;

function appendOutput(output, chunk) {
  if (output.length >= OUTPUT_LIMIT) return output;
  const remaining = OUTPUT_LIMIT - output.length;
  const text = chunk.toString();
  return output + text.slice(0, remaining);
}

function waitForChildClose(child) {
  return new Promise((resolveFn) => {
    child.once('close', resolveFn);
  });
}

function diagnostic(...parts) {
  return parts.join('').slice(0, OUTPUT_LIMIT);
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

function listSampleFiles() {
  const out = [];
  for (const root of SAMPLE_ROOTS) {
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    (function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith('.mjs')) out.push(p);
      }
    })(root);
  }
  return out.sort();
}

function loadSample(file) {
  return new Promise((resolveFn) => {
    const cwd = mkdtempSync(join(tmpdir(), 'projects-smoke-'));
    const child = spawn('node', [file], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '0' }, // preferred free-port when sample honors PORT
    });
    const childClosed = waitForChildClose(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = appendOutput(stderr, d); });
    let settled = false;
    let loadTimer;
    const settle = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      await cleanupChild(child, childClosed, cwd);
      resolveFn(result);
    };
    child.on('exit', (code) => {
      if (code === 0) settle({ ok: true });
      else if (code !== null) settle({ ok: false, code, stderr });
    });
    child.on('error', (err) => settle({ ok: false, code: -1, stderr: appendOutput(stderr, err) }));
    loadTimer = setTimeout(() => settle({ ok: true }), LOAD_WINDOW_MS);
  });
}

const files = listSampleFiles();
assert.ok(files.length >= 10, 'expected sample mjs files under projects/ and examples/');

for (const file of files) {
  const rel = relative(REPO, file);
  test(`sample smoke: ${rel} loads`, { concurrency: false }, async () => {
    const result = await loadSample(file);
    if (result.ok) return;
    assert.fail(
      diagnostic(`${rel} crashed at load (exit ${result.code}):\n`, result.stderr),
    );
  });
}
