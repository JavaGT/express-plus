#!/usr/bin/env node
// Serialize heavyweight check/test commands machine-wide so concurrent agents
// queue instead of colliding (load spikes, Vite-cache thrash, benchmark
// contamination). Consensus design:
// - Lock is an atomic `mkdir` lockdir under a SHARED absolute path, so Scope and
//   Workbench coordinate with each other.
// - Stale locks are detected by PID liveness (never by age alone — a valid
//   type-check can legitimately run long).
// - Timeout expires with exit code 75 (EX_TEMPFAIL); the caller decides.
// - The exact child exit code passes through; output is not filtered.
//
// Usage: node scripts/heavy-command.mjs [--timeout-seconds N] -- <command> [args...]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_ROOT = process.env.SCOPE_HEAVY_LOCK_DIR ?? join(tmpdir(), 'scope-heavy-lock');
const POLL_MS = 2000;
const DEFAULT_TIMEOUT_SECONDS = 900;

const rawArgs = process.argv.slice(2);
// pnpm injects its own `--` before script arguments; strip any leading ones.
while (rawArgs[0] === '--') rawArgs.shift();
let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
if (rawArgs[0] === '--timeout-seconds') {
	timeoutSeconds = Number.parseInt(rawArgs[1] ?? '', 10);
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		console.error('heavy-command: --timeout-seconds needs a positive integer');
		process.exit(1);
	}
	rawArgs.splice(0, 2);
}
const [separator, ...command] = rawArgs;
// Accept both `-- cmd` and a bare command list (pnpm's `--` may already have
// been consumed by the shell or stripped above).
if ((separator !== '--' && separator?.startsWith('-')) || command.length === 0) {
	console.error('usage: heavy-command.mjs [--timeout-seconds N] -- <command> [args...]');
	process.exit(1);
}
const finalCommand = separator === '--' ? command : [separator, ...command];

function ownerAlive(lockDir) {
	try {
		const pid = Number.parseInt(readFileSync(join(lockDir, 'owner'), 'utf8'), 10);
		if (!Number.isInteger(pid) || pid <= 0) return true; // unreadable => assume alive, never steal on guesswork
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error.code === 'EPERM'; // EPERM means the process exists but is not ours
		}
	} catch {
		return true;
	}
}

mkdirSync(LOCK_ROOT, { recursive: true });
// Mutual exclusion needs ONE fixed slot — unique names would let every caller
// win immediately.
const lockDir = join(LOCK_ROOT, 'slot');
const startedAt = Date.now();
let held = false;
while (!held) {
	const stale = !ownerAlive(lockDir);
	if (stale) rmSync(lockDir, { recursive: true, force: true }); // owner is provably dead
	try {
		mkdirSync(lockDir);
		held = true;
	} catch { /* occupied by a live owner — wait for the current holder */ }
	if (!held && (Date.now() - startedAt) / 1000 > timeoutSeconds) {
		console.error(`heavy-command: timed out after ${timeoutSeconds}s waiting for a heavy-command slot`);
		process.exit(75);
	}
	if (!held) await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
}

writeFileSync(join(lockDir, 'owner'), String(process.pid));
writeFileSync(join(lockDir, 'command'), finalCommand.join(' '));

let result;
try {
	result = spawnSync(finalCommand[0], finalCommand.slice(1), { stdio: 'inherit' });
} finally {
	rmSync(lockDir, { recursive: true, force: true });
}
process.exit(result?.status ?? 1);
