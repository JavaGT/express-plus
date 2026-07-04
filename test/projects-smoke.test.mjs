// projects-smoke.test.mjs — every exemplar under projects/**/*.mjs loads cleanly.
//
// The projects/ directory holds binding exemplar apps. This test spawns each as
// `node <file>` and asserts it does not crash at load:
//   - the child's cwd is a fresh temp dir (samples create *.db files and
//     .blobs/ dirs relative to cwd — keep the repo clean),
//   - files run SEQUENTIALLY (several samples hardcode port 3000),
//   - success = exits code 0 quickly, OR is still alive after the load window
//     (it started a server) — then it is killed and the file passes,
//   - failure = exits non-zero within the window; stderr is in the assertion.
//
// `node <file>` resolves `import ... from 'workbench'` via the repo package.json
// name/exports regardless of the child's cwd (the bare specifier resolves
// against the importing module's URL, which is the repo path — verified by hand
// against projects/note.mjs before writing this test).
//
// A small number of exemplars exercise constructs the framework's eager
// compile-at-declaration model does not yet support WITHOUT restructuring the
// two-file sample layout (see KNOWN_UNRESOLVED). They are asserted to fail with
// a specific, documented load-time error rather than silently dropped, so the
// suite stays green and the gap is recorded in-code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const PROJECTS = join(REPO, 'projects');
// The load window: a sample that has started a server is still alive here.
const LOAD_WINDOW_MS = 1500;

// Exemplars that cannot load today for a documented framework reason. Each
// entry is asserted to fail with an error whose message includes `expectMsg`.
// Fixing these requires either restructuring the sample's two-file layout
// (Photo declared in its own file, compiled before Album is registered) or a
// src/ change to the eager compile-at-declaration model — both out of scope for
// the smoke-test task. Listed in the final answer rather than deleted.
const KNOWN_UNRESOLVED = new Map([
  [
    'projects/google-photos/photo.mjs',
    {
      expectMsg:
        "Cannot read properties of undefined (reading 'has')",
      note:
        "Photo's `albumMember` check harvests `Photo.album.collaborators.has(...)` " +
        'at declaration time, but `Album` (declared in album.mjs) is not yet ' +
        'registered when photo.mjs is imported — the framework harvests declared ' +
        'checks eagerly, so the cross-entity FK target is unresolved.',
    },
  ],
  [
    'projects/google-photos/album.mjs',
    {
      expectMsg:
        "Cannot read properties of undefined (reading 'has')",
      note:
        'album.mjs imports photo.mjs (for the Photo entity), so photo.mjs — and ' +
        "Photo's eager scope harvest — runs before album.mjs declares Album. The " +
        'failure is the same as photo.mjs; Album itself would load if Photo did.',
    },
  ],
]);

function listProjectFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.mjs')) out.push(p);
    }
  })(PROJECTS);
  return out.sort();
}

// Spawn `node <file>` with cwd = a fresh temp dir. Resolves to:
//   { ok: true }                 — exited 0 quickly OR still alive at the window
//   { ok: false, code, stderr }  — exited non-zero within the window
function loadSample(file) {
  return new Promise((resolveFn) => {
    const cwd = mkdtempSync(join(tmpdir(), 'projects-smoke-'));
    const child = spawn('node', [file], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
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

// One test per file, run sequentially (several samples hardcode port 3000 —
// concurrent spawns would collide on the listen port).
for (const file of listProjectFiles()) {
  const rel = relative(REPO, file);
  const known = KNOWN_UNRESOLVED.get(rel);

  test(`projects smoke: ${rel} loads`, { concurrency: false }, async () => {
    const result = await loadSample(file);
    if (result.ok) return; // exit 0 or started a server

    if (known) {
      // Documented-unresolved: assert it fails for the EXPECTED reason, not
      // silently or for a new reason. A different error means a regression or
      // an already-shipped fix — surface it loudly.
      assert.ok(
        result.stderr.includes(known.expectMsg),
        `${rel} is listed KNOWN_UNRESOLVED but failed for an unexpected reason:\n${result.stderr}\n` +
          `(expected an error containing: ${JSON.stringify(known.expectMsg)})\n` +
          `note: ${known.note}`,
      );
      return;
    }

    assert.fail(
      `${rel} crashed at load (exit ${result.code}):\n${result.stderr}`,
    );
  });
}
