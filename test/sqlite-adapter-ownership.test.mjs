// sqlite-adapter-ownership.test.mjs — S1/A2 OS-backed ownership lock. The lock's
// authority is a held BEGIN EXCLUSIVE on a sidecar lock database: a second
// PROCESS opening the same directory fails loudly with WB_DB_OWNED (never raw
// SQLITE_BUSY contention, never kill(pid,0) probing), and a crashed process's
// lock is released by the OS when its connections die.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  openSqliteAdapter,
  DB_OWNED_ERROR_CODE,
  SQLITE_LOCK_FILENAME,
} from '../build/sqlite-adapter.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'wb-adapter-ownership-'));
}

function runChild(source) {
  return spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Collect stdout until the child exits, resolving with { code, signal, stdout }.
function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

// Wait until the child's stdout contains `needle` (or the child exits).
async function waitForOutput(child, needle, timeoutMs = 8000) {
  let stdout = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never printed '${needle}'`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes(needle)) {
        clearTimeout(timer);
        resolve(stdout);
      }
    });
  });
}

test('a second process opening an owned directory fails loudly with WB_DB_OWNED', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  const holder = openSqliteAdapter({ directory: dir, name: 'app' });
  try {
    const child = runChild(`
      import { openSqliteAdapter } from './build/sqlite-adapter.mjs';
      try {
        openSqliteAdapter({ directory: ${JSON.stringify(dir)}, name: 'app' });
        process.stdout.write('OPENED\\n');
      } catch (err) {
        process.stdout.write('REFUSED ' + (err.code ?? 'no-code') + '\\n');
        process.exitCode = 3;
      }
    `);
    const result = await collect(child);
    assert.match(result.stdout, /REFUSED/);
    assert.match(result.stdout, new RegExp(DB_OWNED_ERROR_CODE), 'error code is WB_DB_OWNED');
    assert.equal(result.stdout.includes('OPENED'), false, 'the second process must not open');
    assert.notEqual(result.code, 0, 'the second process fails loudly (non-zero exit)');
    assert.doesNotMatch(result.stdout, /SQLITE_BUSY/, 'never a raw busy error');
  } finally {
    holder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live owner (child) refuses an in-process second open with WB_DB_OWNED', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  const child = runChild(`
    import { openSqliteAdapter } from './build/sqlite-adapter.mjs';
    openSqliteAdapter({ directory: ${JSON.stringify(dir)}, name: 'app' });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `);
  try {
    await waitForOutput(child, 'ready');
    assert.throws(
      () => openSqliteAdapter({ directory: dir, name: 'app' }),
      (err) => err.code === DB_OWNED_ERROR_CODE,
      'the live owner is refused via the held BEGIN EXCLUSIVE',
    );
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    // After the owner dies, the lock is gone and the directory opens again.
    const reopened = openSqliteAdapter({ directory: dir, name: 'app' });
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crashed process\'s lock is released by the OS (no stale lock survives)', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  const child = runChild(`
    import { openSqliteAdapter } from './build/sqlite-adapter.mjs';
    openSqliteAdapter({ directory: ${JSON.stringify(dir)}, name: 'app' });
    process.stdout.write('ready\\n');
    // Simulate a crash: exit without close() — the held exclusive transaction
    // dies with the process and the OS releases its file locks.
    process.exit(1);
  `);
  await waitForOutput(child, 'ready');
  const result = await collect(child);
  assert.equal(result.code, 1, 'child crashed as simulated');
  // The OS dropped the held lock: a fresh adapter can own the directory now.
  const reopened = openSqliteAdapter({ directory: dir, name: 'app' });
  reopened.close();
  rmSync(root, { recursive: true, force: true });
});

test('the diagnostics row records the owner pid (informational, committed)', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'owned');
  const holder = openSqliteAdapter({ directory: dir, name: 'app' });
  holder.close();
  // The row is committed and survives release — but it is NEVER consulted for
  // liveness (a crash leaves a stale pid behind; the OS lock is the authority).
  const probe = new (await import('node:sqlite')).DatabaseSync(path.join(dir, SQLITE_LOCK_FILENAME));
  try {
    const persisted = probe.prepare('SELECT pid, startedAt FROM owner').get();
    assert.deepEqual({ ...persisted }, { pid: process.pid, startedAt: persisted.startedAt });
    assert.ok(!Number.isNaN(Date.parse(persisted.startedAt)), 'startedAt is a timestamp');
  } finally {
    probe.close();
  }
  rmSync(root, { recursive: true, force: true });
});
