#!/usr/bin/env node
// Serialize heavyweight check/test commands machine-wide so concurrent agents
// queue instead of colliding (load spikes, Vite-cache thrash, benchmark
// contamination). Consensus design:
// - Lock is an atomic `mkdir` lockdir under a SHARED absolute path, so Scope and
//   Workbench coordinate with each other.
// - Stale locks are detected by PID liveness (never by age alone — a valid
//   type-check can legitimately run long). A lock whose owner cannot be read is
//   presumed dead once the slot is older than OWNER_GRACE_MS — that recovers the
//   crash-between-mkdir-and-owner-write state that plain PID liveness can never
//   clear (the old code treated an unreadable owner as alive forever). A slot
//   mtime ahead of the local clock (clock/fs skew) is treated as stale at once —
//   no holder can legitimately create a lock 'in the future', and a skewed mtime
//   would otherwise satisfy the grace comparison forever.
// - Timeout expires with exit code 75 (EX_TEMPFAIL); the caller decides.
// - The exact child exit code passes through; output is not filtered.
//
// Usage: node scripts/heavy-command.mjs [--timeout-seconds N] -- <command> [args...]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_ROOT = process.env.SCOPE_HEAVY_LOCK_DIR ?? join(tmpdir(), 'scope-heavy-lock');
// Fixed slot name — mutual exclusion needs ONE slot (unique names would let every
// caller win immediately), and it must stay `slot` so Scope and Workbench
// coordinate on the same artifact.
const LOCK_NAME = 'slot';
const POLL_MS = 2000;
const DEFAULT_TIMEOUT_SECONDS = 900;
// How long a slot with an unreadable/missing owner is presumed to belong to a
// holder still between mkdir and its owner-write. 10s dwarfs that microsecond
// window while keeping next-run recovery prompt (bounded by POLL_MS).
const OWNER_GRACE_MS = 10_000;
// A slot mtime ahead of the local clock by more than this is clock/fs skew, not
// evidence of a live holder. Without this guard a skewed (future) mtime makes
// the grace comparison below always true — `now - mtimeMs` goes negative — which
// would keep a crashed lock alive indefinitely. 5s dwarfs clock jitter.
const FUTURE_SKEW_TOLERANCE_MS = 5_000;

// Owner liveness. The owner PID lives in <lockDir>/owner, written atomically
// (temp file + rename), so a crash never leaves a half-written owner. A slot
// whose owner is missing/unreadable means the holder crashed inside that write
// window — or is just starting up; the slot directory's age disambiguates.
export function ownerAlive(lockDir, now = Date.now()) {
	let pid;
	try {
		pid = Number.parseInt(readFileSync(join(lockDir, 'owner'), 'utf8'), 10);
	} catch {
		pid = NaN;
	}
	if (!Number.isInteger(pid) || pid <= 0) {
		let stat;
		try {
			stat = statSync(lockDir);
		} catch {
			return false; // slot vanished — nobody holds it
		}
		const ageMs = now - stat.mtimeMs;
		// A mtime ahead of the clock (beyond a small tolerance) is skew on the
		// holder's clock or filesystem, not evidence of a live holder: no holder
		// can legitimately have created the lock 'in the future'. Without this
		// guard a skewed mtime would satisfy the grace comparison below forever,
		// keeping a crashed lock alive indefinitely. Treat it as stale at once.
		if (ageMs < -FUTURE_SKEW_TOLERANCE_MS) return false;
		return ageMs < OWNER_GRACE_MS;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM'; // EPERM means the process exists but is not ours
	}
}

// Atomically publish the owner PID: write a temp file in the same directory,
// then rename it into place (rename is atomic on POSIX). A crash in between
// leaves the slot without an owner, which ownerAlive() recovers after the grace
// period instead of blocking every later caller.
export function writeOwner(lockDir) {
	const ownerPath = join(lockDir, 'owner');
	const tmpPath = join(lockDir, `.owner.tmp-${process.pid}`);
	writeFileSync(tmpPath, String(process.pid));
	renameSync(tmpPath, ownerPath);
}

// Acquire the single fixed slot, recovering stale locks automatically.
export async function acquireLock(
	lockRoot,
	{ timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, pollMs = POLL_MS } = {}
) {
	mkdirSync(lockRoot, { recursive: true });
	const lockDir = join(lockRoot, LOCK_NAME);
	const startedAt = Date.now();
	while (true) {
		if (!ownerAlive(lockDir)) {
			rmSync(lockDir, { recursive: true, force: true }); // owner is provably dead
		}
		try {
			mkdirSync(lockDir);
			writeOwner(lockDir);
			return lockDir;
		} catch {
			/* occupied by a live owner — wait for the current holder */
		}
		if ((Date.now() - startedAt) / 1000 > timeoutSeconds) {
			throw new Error(`heavy-command: timed out after ${timeoutSeconds}s waiting for a heavy-command slot`);
		}
		await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
	}
}

async function main() {
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

	const lockDir = await acquireLock(LOCK_ROOT, { timeoutSeconds });
	writeFileSync(join(lockDir, 'command'), finalCommand.join(' '));

	let result;
	try {
		result = spawnSync(finalCommand[0], finalCommand.slice(1), { stdio: 'inherit' });
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
	process.exit(result?.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(75);
	});
}
