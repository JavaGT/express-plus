// Check that test coverage meets the minimum threshold.
// Run after `node --experimental-test-coverage --test`; reads its stdout.
// Usage: node scripts/check-coverage.mjs <threshold>
// Exit 0 if coverage >= threshold; exit 1 otherwise.

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const threshold = Number.parseFloat(process.argv[2] ?? '85');
if (Number.isNaN(threshold)) {
  console.error('Usage: node scripts/check-coverage.mjs <threshold>');
  process.exit(2);
}

const result = spawnSync('node', ['--experimental-test-coverage', '--test'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  timeout: 5 * 60_000,
});

const output = result.stdout;
const match = output.match(/^ℹ\s+all files\s+\|\s+([\d.]+)\s/m);
if (!match) {
  console.error('Could not find "all files" coverage line in test output.');
  process.exit(1);
}

const pct = Number.parseFloat(match[1]);
console.log(`Coverage: ${pct.toFixed(2)}% (threshold: ${threshold}%)`);

if (pct < threshold) {
  console.error(`Coverage ${pct.toFixed(2)}% is below threshold ${threshold}%.`);
  process.exit(1);
}

console.log('Coverage check passed.');
process.exit(0);