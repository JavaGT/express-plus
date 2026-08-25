// Architecture-map drift check. Scans docs/architecture-map.md for back-ticked
// .mjs tokens and asserts each resolves to a real file under the
// classification rules below. Four-class token grammar with explicit
// precedence (first match wins, classes disjoint by construction).
//
// Plan reference: docs/skill-audits/next-authority-migration-plan.md §3.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapPath = join(root, 'docs/architecture-map.md');

// ---------------------------------------------------------------------------
// Token grammar — explicit precedence; first match wins, classes disjoint.
// ---------------------------------------------------------------------------
//
// 1. GLOB-DOC: contains `**` → never checked; documentation about the tree.
// 2. PATTERN: contains a single-segment `*` wildcard but no `**` → expand
//    against the root the path names: `build/`-prefixed against build/,
//    `public/`-prefixed against public/, otherwise root. Pass if ≥1 match.
// 3. PUBLIC: starts with `public/`, no wildcard remaining → must exist
//    verbatim under repo root.
// 4. BUILD: anything else ending `.mjs` → must exist at `build/<token>`.
//
// Anything else ending `.mjs` that doesn't match rules 1-4 is a scanner
// failure (unclassified shape) — fail loudly so the grammar gets extended
// deliberately.

const BACKTICK_TOKEN = /`([^`]*\.mjs)`/g;

function classify(token) {
	if (token.includes('**')) return 'GLOB-DOC';
	if (token.includes('*')) return 'PATTERN';
	if (token.startsWith('public/')) return 'PUBLIC';
	return 'BUILD';
}

function listFiles(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(path));
		else if (entry.isFile()) out.push(path);
	}
	return out;
}

function expandPattern(token) {
	let base;
	if (token.startsWith('build/')) base = join(root, 'build');
	else if (token.startsWith('public/')) base = join(root, 'public');
	else base = root;
	const files = listFiles(base);
	const suffix = token.split('/').pop();
	// Convert the single-segment `*` wildcard to a regex.
	const regex = new RegExp('^' + suffix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$');
	return files.filter((file) => regex.test(relative(base, file).split('/').pop() ?? ''));
}

function resolveToken(token) {
	switch (classify(token)) {
		case 'GLOB-DOC':
			return { ok: true, kind: 'GLOB-DOC', skipped: true };
		case 'PATTERN': {
			const matches = expandPattern(token);
			if (matches.length === 0) {
				return { ok: false, kind: 'PATTERN', error: `pattern matched 0 files` };
			}
			return { ok: true, kind: 'PATTERN', matches: matches.map((m) => relative(root, m)) };
		}
		case 'PUBLIC': {
			const path = join(root, token);
			if (!existsSync(path)) return { ok: false, kind: 'PUBLIC', error: `public token missing: ${token}` };
			return { ok: true, kind: 'PUBLIC', path: relative(root, path) };
		}
		case 'BUILD': {
			const path = join(root, 'build', token);
			if (!existsSync(path)) return { ok: false, kind: 'BUILD', error: `build token missing: build/${token}` };
			return { ok: true, kind: 'BUILD', path: relative(root, path) };
		}
		default:
			return { ok: false, kind: 'UNCLASSIFIED', error: `unclassified token shape: ${token}` };
	}
}

// ---------------------------------------------------------------------------
// --report-unmapped: list build/**/*.mjs files no map row cites (report only).
// ---------------------------------------------------------------------------
function reportUnmapped(tokens) {
	const cited = new Set();
	for (const token of tokens) {
		if (classify(token) === 'BUILD') cited.add(token);
	}
	const buildFiles = listFiles(join(root, 'build'));
	const unmapped = [];
	for (const file of buildFiles) {
		const relPath = relative(join(root, 'build'), file).replaceAll('\\', '/');
		if (!cited.has(relPath)) unmapped.push(relPath);
	}
	return unmapped;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
	const source = readFileSync(mapPath, 'utf8');
	const tokens = [];
	for (const match of source.matchAll(BACKTICK_TOKEN)) {
		tokens.push(match[1]);
	}

	const failures = [];
	for (const token of tokens) {
		const result = resolveToken(token);
		if (!result.ok) failures.push(`  - ${token} [${result.kind}]: ${result.error}`);
	}

	if (failures.length > 0) {
		console.error(`architecture-map drift: ${failures.length} failing token(s):`);
		for (const line of failures) console.error(line);
		process.exit(1);
	}

	const counts = tokens.reduce((acc, t) => {
		const k = classify(t);
		acc[k] = (acc[k] ?? 0) + 1;
		return acc;
	}, {});

	if (process.argv.includes('--report-unmapped')) {
		const unmapped = reportUnmapped(tokens);
		console.log(`architecture-map: ok (${tokens.length} tokens checked; ${JSON.stringify(counts)})`);
		if (unmapped.length > 0) {
			console.log(`unmapped build files (report-only):`);
			for (const f of unmapped) console.log(`  - build/${f}`);
		}
	} else {
		console.log(`architecture-map: ok (${tokens.length} tokens checked; ${JSON.stringify(counts)})`);
	}
}

// CLI entry. Allow being `require`d from the self-test so fixtures can call
// classify()/resolveToken() without spawning a child process.
if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

export { classify, expandPattern, resolveToken, listFiles, reportUnmapped, main, BACKTICK_TOKEN };
