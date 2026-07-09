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
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const SAMPLE_ROOTS = [join(REPO, 'projects'), join(REPO, 'examples')];
const LOAD_WINDOW_MS = 1500;

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
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '0' }, // preferred free-port when sample honors PORT
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolveFn(result);
    };
    child.on('exit', (code) => {
      if (code === 0) settle({ ok: true });
      else if (code !== null) settle({ ok: false, code, stderr });
    });
    child.on('error', (err) => settle({ ok: false, code: -1, stderr: String(err) }));
    setTimeout(() => settle({ ok: true }), LOAD_WINDOW_MS);
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
      `${rel} crashed at load (exit ${result.code}):\n${result.stderr}`,
    );
  });
}
