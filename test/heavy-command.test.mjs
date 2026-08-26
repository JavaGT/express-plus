// Self-test for scripts/heavy-command.mjs (mirrors Scope's recovery fix).
// Covers the crash-between-steps lock state — a pre-existing slot with a
// missing owner, a dead-PID owner, or a future-dated (clock/fs-skewed) mtime —
// which plain PID-liveness treated as alive forever. Uses an isolated
// SCOPE_HEAVY_LOCK_DIR under os.tmpdir() — never the real shared lock root.
//
// Run: node --test test/heavy-command.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireLock, ownerAlive, writeOwner } from '../scripts/heavy-command.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'heavy-command.mjs');
const LOCK_ROOT = join(mkdtempSync(join(tmpdir(), 'heavy-lock-test-')), 'lock-root');

// A pid that cannot exist on this machine (macOS kern.maxpid is 99999), so
// process.kill(pid, 0) reliably returns ESRCH.
const DEAD_PID = 999999;
const OLD_MS = 60_000; // well past OWNER_GRACE_MS (10s)
const FUTURE_MS = 60_000; // mtime 60s ahead of the clock — well past the 5s skew tolerance
const SMALL_FUTURE_MS = 1_000; // mtime 1s ahead — within the 5s skew tolerance

// ageMs is signed: positive = mtime in the past, negative = mtime in the future.
function makeSlot({ owner = null, ageMs = 0 } = {}) {
	const slot = join(LOCK_ROOT, 'slot');
	rmSync(slot, { recursive: true, force: true }); // fresh state per call
	mkdirSync(slot, { recursive: true });
	if (owner !== null) writeFileSync(join(slot, 'owner'), owner);
	if (ageMs !== 0) {
		const time = new Date(Date.now() - ageMs);
		utimesSync(slot, time, time);
	}
	return slot;
}

test('ownerAlive: live PID owner is alive', () => {
	const slot = makeSlot({ owner: String(process.pid) });
	assert.equal(ownerAlive(slot), true);
});

test('ownerAlive: dead PID owner is dead (stealable)', () => {
	const slot = makeSlot({ owner: String(DEAD_PID) });
	assert.equal(ownerAlive(slot), false);
});

test('ownerAlive: fresh no-owner slot is presumed alive (just-starting holder)', () => {
	const slot = makeSlot(); // no owner file, current mtime
	assert.equal(ownerAlive(slot), true);
});

test('ownerAlive: old no-owner slot is dead (crashed before owner-write)', () => {
	const slot = makeSlot({ ageMs: OLD_MS }); // no owner file, old mtime
	assert.equal(ownerAlive(slot), false);
});

test('ownerAlive: future-dated no-owner slot is dead (clock/fs skew, not alive forever)', () => {
	const slot = makeSlot({ ageMs: -FUTURE_MS }); // mtime 60s ahead of the clock
	assert.equal(ownerAlive(slot), false);
});

test('ownerAlive: future mtime within the skew tolerance is still presumed alive (clock jitter)', () => {
	const slot = makeSlot({ ageMs: -SMALL_FUTURE_MS }); // mtime 1s ahead — inside the 5s tolerance
	assert.equal(ownerAlive(slot), true);
});

test('writeOwner: publishes the PID and leaves no temp file behind', () => {
	const slot = makeSlot();
	writeOwner(slot);
	assert.equal(readFileSync(join(slot, 'owner'), 'utf8'), String(process.pid));
	const leftovers = readdirSync(slot).filter((f) => f.includes('.owner.tmp'));
	assert.deepEqual(leftovers, []);
});

test('acquireLock: recovers a stale slot with a missing owner and proceeds', async () => {
	const root = join(LOCK_ROOT, 'crash-missing');
	mkdirSync(join(root, 'slot'), { recursive: true }); // crashed between mkdir and owner-write
	utimesSync(join(root, 'slot'), new Date(Date.now() - OLD_MS), new Date(Date.now() - OLD_MS));
	const lockDir = await acquireLock(root, { timeoutSeconds: 5, pollMs: 10 });
	assert.equal(lockDir, join(root, 'slot'));
	assert.equal(readFileSync(join(lockDir, 'owner'), 'utf8'), String(process.pid));
});

test('acquireLock: recovers a future-dated stale slot (skewed clock/fs) and proceeds', async () => {
	const root = join(LOCK_ROOT, 'skew-future');
	mkdirSync(join(root, 'slot'), { recursive: true }); // crash state with a future mtime
	utimesSync(join(root, 'slot'), new Date(Date.now() + FUTURE_MS), new Date(Date.now() + FUTURE_MS));
	const lockDir = await acquireLock(root, { timeoutSeconds: 5, pollMs: 10 });
	assert.equal(lockDir, join(root, 'slot'));
	assert.equal(readFileSync(join(lockDir, 'owner'), 'utf8'), String(process.pid));
});

test('CLI: next run proceeds past a crashed slot (missing owner) and releases it', () => {
	const root = join(LOCK_ROOT, 'cli-crash');
	mkdirSync(join(root, 'slot'), { recursive: true }); // crash state
	utimesSync(join(root, 'slot'), new Date(Date.now() - OLD_MS), new Date(Date.now() - OLD_MS));
	const marker = join(LOCK_ROOT, 'cli-marker.txt');
	const result = spawnSync(
		process.execPath,
		[SCRIPT, '--timeout-seconds', '5', 'node', '-e', "require('node:fs').writeFileSync(process.env.MARKER, 'ok')"],
		{
			encoding: 'utf8',
			env: { ...process.env, SCOPE_HEAVY_LOCK_DIR: root, MARKER: marker },
		}
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(marker), true, 'child command did not run');
	assert.equal(existsSync(join(root, 'slot')), false, 'slot must be released after the run');
});
