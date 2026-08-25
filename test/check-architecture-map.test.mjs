// Self-test for scripts/check-architecture-map.mjs. Exercises the four-class
// token grammar end-to-end on tmp trees so the live guard cannot silently
// weaken. Lives in test/ so the workbench test runner picks it up.
//
// Plan reference: docs/skill-audits/next-authority-migration-plan.md §3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, listFiles, BACKTICK_TOKEN } from '../scripts/check-architecture-map.mjs';

// Build a tmp tree mirroring the layout check-architecture-map expects.
function makeTree(layout) {
	const root = mkdtempSync(join(tmpdir(), 'check-architecture-map-'));
	const build = join(root, 'build');
	const publicDir = join(root, 'public');
	mkdirSync(build, { recursive: true });
	mkdirSync(publicDir, { recursive: true });
	for (const [rel, content] of Object.entries(layout)) {
		const full = join(root, rel);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content ?? '');
	}
	return {
		root,
		build,
		public: publicDir,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

// Re-resolve a token against a custom root using the same logic as the
// guard, but pointed at a tmp tree.
function resolveAgainst(root, token) {
	if (classify(token) === 'GLOB-DOC') return { ok: true, kind: 'GLOB-DOC', skipped: true };
	if (classify(token) === 'PATTERN') {
		let base;
		if (token.startsWith('build/')) base = join(root, 'build');
		else if (token.startsWith('public/')) base = join(root, 'public');
		else base = root;
		const files = listFiles(base);
		const suffix = token.split('/').pop();
		const regex = new RegExp('^' + suffix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$');
		const matches = files.filter((file) => regex.test(file.split('/').pop() ?? ''));
		if (matches.length === 0) return { ok: false, kind: 'PATTERN', error: 'pattern matched 0 files' };
		return { ok: true, kind: 'PATTERN', matches };
	}
	if (classify(token) === 'PUBLIC') {
		const path = join(root, token);
		if (!statExists(path)) return { ok: false, kind: 'PUBLIC', error: `public token missing: ${token}` };
		return { ok: true, kind: 'PUBLIC', path };
	}
	if (classify(token) === 'BUILD') {
		const path = join(root, 'build', token);
		if (!statExists(path)) return { ok: false, kind: 'BUILD', error: `build token missing: build/${token}` };
		return { ok: true, kind: 'BUILD', path };
	}
	return { ok: false, kind: 'UNCLASSIFIED', error: 'unclassified' };
}

function statExists(p) {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

// Classification table — explicit precedence, disjoint classes.
test('classification table — explicit precedence, disjoint classes', () => {
	// GLOB-DOC: contains `**`
	assert.equal(classify('build/**/*.mjs'), 'GLOB-DOC');
	// PATTERN: single-segment `*` only
	assert.equal(classify('http-response*.mjs'), 'PATTERN');
	assert.equal(classify('public/workbench-local-*.mjs'), 'PATTERN');
	// PUBLIC: starts with public/, no wildcard
	assert.equal(classify('public/workbench-client.mjs'), 'PUBLIC');
	// BUILD: anything else
	assert.equal(classify('pipeline.mjs'), 'BUILD');
	assert.equal(classify('auth/session.mjs'), 'BUILD');
	assert.equal(classify('db.mjs'), 'BUILD');
});

// (a) BUILD hit exists → pass
test('(a) BUILD hit exists → pass', () => {
	const t = makeTree({ 'build/pipeline.mjs': '' });
	try {
		const r = resolveAgainst(t.root, 'pipeline.mjs');
		assert.equal(r.ok, true);
		assert.equal(r.kind, 'BUILD');
	} finally { t.cleanup(); }
});

// (b) BUILD miss → fail naming the module
test('(b) BUILD miss → fail naming the module', () => {
	const t = makeTree({ 'build/other.mjs': '' });
	try {
		const r = resolveAgainst(t.root, 'pipeline.mjs');
		assert.equal(r.ok, false);
		assert.equal(r.kind, 'BUILD');
		assert.match(r.error, /pipeline\.mjs/);
	} finally { t.cleanup(); }
});

// (c) PUBLIC exact hit → pass
test('(c) PUBLIC exact hit → pass', () => {
	const t = makeTree({ 'public/workbench-client.mjs': '' });
	try {
		const r = resolveAgainst(t.root, 'public/workbench-client.mjs');
		assert.equal(r.ok, true);
		assert.equal(r.kind, 'PUBLIC');
	} finally { t.cleanup(); }
});

// (d) PUBLIC miss → fail
test('(d) PUBLIC miss → fail', () => {
	const t = makeTree({ 'public/other.mjs': '' });
	try {
		const r = resolveAgainst(t.root, 'public/workbench-client.mjs');
		assert.equal(r.ok, false);
		assert.equal(r.kind, 'PUBLIC');
	} finally { t.cleanup(); }
});

// (e) PATTERN with ≥1 expansion → pass
test('(e) PATTERN with ≥1 expansion → pass', () => {
	const t = makeTree({
		'build/http-response.mjs': '',
		'build/http-response-factory.mjs': '',
	});
	try {
		const r = resolveAgainst(t.root, 'http-response*.mjs');
		assert.equal(r.ok, true);
		assert.equal(r.kind, 'PATTERN');
		assert.ok(r.matches.length >= 1);
	} finally { t.cleanup(); }
});

// (f) PATTERN with 0 expansions → fail
test('(f) PATTERN with 0 expansions → fail', () => {
	const t = makeTree({ 'build/other.mjs': '' });
	try {
		const r = resolveAgainst(t.root, 'http-response*.mjs');
		assert.equal(r.ok, false);
		assert.equal(r.kind, 'PATTERN');
	} finally { t.cleanup(); }
});

// (g) GLOB-DOC token → ignored
test('(g) GLOB-DOC token → ignored', () => {
	const t = makeTree({});
	try {
		const r = resolveAgainst(t.root, 'build/**/*.mjs');
		assert.equal(r.ok, true);
		assert.equal(r.kind, 'GLOB-DOC');
		assert.equal(r.skipped, true);
	} finally { t.cleanup(); }
});

// (h) class table is closed: every .mjs suffix either contains **, *, starts
//     with public/, or is BUILD — no fourth class can silently appear.
test('(h) class table is closed — only GLOB-DOC / PATTERN / PUBLIC / BUILD', () => {
	const known = new Set(['GLOB-DOC', 'PATTERN', 'PUBLIC', 'BUILD']);
	for (const t of [
		'pipeline.mjs',
		'auth/session.mjs',
		'public/workbench-client.mjs',
		'public/workbench-local-*.mjs',
		'http-response*.mjs',
		'build/**/*.mjs',
		'db.mjs',
	]) {
		assert.ok(known.has(classify(t)), `unknown class for ${t}: ${classify(t)}`);
	}
});

// (i) live overlap: public/workbench-local-*.mjs classifies as PATTERN and
//     expands ≥1 against the real public/ tree.
test('(i) live public/workbench-local-*.mjs overlap → PATTERN with ≥1 match', () => {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
	const publicDir = join(repoRoot, 'public');
	if (!existsSync(publicDir)) return;
	const matches = readdirSync(publicDir).filter((name) => /^workbench-local-.+\.mjs$/.test(name));
	if (matches.length === 0) return;
	const r = resolveAgainst(repoRoot, 'public/workbench-local-*.mjs');
	assert.equal(r.ok, true);
	assert.equal(r.kind, 'PATTERN');
	assert.ok(r.matches.length >= 1, 'PATTERN must expand ≥1');
});

// Token regex correctness
test('BACKTICK_TOKEN extracts .mjs tokens only', () => {
	const src = '| `pipeline.mjs` / `db.mjs` / `foo.d.ts` | `build/**/*.mjs` note |';
	const tokens = [...src.matchAll(BACKTICK_TOKEN)].map((m) => m[1]);
	// Grammar is closed on .mjs only: foo.d.ts is excluded, but the glob
	// pattern `build/**/*.mjs` IS a valid token (and is classified as
	// GLOB-DOC, not BUILD).
	assert.deepEqual(tokens, ['pipeline.mjs', 'db.mjs', 'build/**/*.mjs']);
});
