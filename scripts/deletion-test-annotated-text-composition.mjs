// Temporary-copy deletion harness for the composite annotated-text seam
// (scope#992 Finding 8). Mutates copies only; the worktree is never edited.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const W1 = [
  {
    name: 'remove-v15-normalizer',
    expected: 'v15 fixture did not reach canonical reducer',
    test: 'test/annotated-text-operated-normalization.test.mjs',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/annotated-text-operated-event.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'if (version === 15) {';
      if (!source.includes(needle)) throw new Error('v15 normalizer case is missing');
      writeFileSync(path, source.replace(
        needle,
        'if (version === 15) {\n    throw new Error(`${entity}.${field}.operated event version 15 is not supported`);\n  }\n  if (false) {',
      ));
    },
  },
  {
    name: 'sparse-region-postimage',
    expected: 'forged region postimage performed a write',
    test: 'test/annotated-text-region-postimage.test.mjs',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/entity/projection.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'postimage = reduceRegionPostimage({';
      if (!source.includes(needle)) throw new Error('reduceRegionPostimage call is missing');
      writeFileSync(path, source.replace(
        needle,
        `postimage = {
      annotations: [],
      affectedIds: canonical.affectedIds,
      emptied: [],
      beforeDigest: canonical.beforeDigest,
      afterDigest: canonical.afterDigest,
    };
    void reduceRegionPostimage; void ({`,
      ));
    },
  },
  {
    name: 'remove-snapshot-cycle-budget',
    expected: 'snapshot recovery exceeded four attempts in one cycle',
    test: 'test/annotated-text-snapshot-cycle-budget-deletion.test.mjs',
    mutate(copyRoot) {
      const path = join(copyRoot, 'public/workbench-client.mjs');
      const source = readFileSync(path, 'utf8');
      const next = source
        .replaceAll('snapshotRecoveryCycle.attempts >= MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE', 'false')
        .replaceAll('snapshotRecoveryCycle && snapshotRecoveryCycle.attempts >= MAX_SNAPSHOT_BOOTSTRAPS_PER_CYCLE', 'false');
      if (next === source) throw new Error('snapshot cycle budget guard is missing');
      writeFileSync(path, next);
    },
  },
];

function copyTree(copyRoot) {
  cpSync(join(root, 'build'), join(copyRoot, 'build'), { recursive: true });
  cpSync(join(root, 'public'), join(copyRoot, 'public'), { recursive: true });
  const tests = [
    'test/annotated-text-operated-normalization.test.mjs',
    'test/annotated-text-region-postimage.test.mjs',
    'test/annotated-text-snapshot-recovery-budget.test.mjs',
    'test/annotated-text-snapshot-cycle-budget-deletion.test.mjs',
    'test/annotated-text-authoring-fixture.mjs',
    'test/fixtures/annotated-text-operated',
  ];
  for (const rel of tests) {
    const from = join(root, rel);
    if (!existsSync(from)) continue;
    const to = join(copyRoot, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

function runMutation(mutation) {
  const copyRoot = mkdtempSync(join(tmpdir(), `wb-at-del-${mutation.name}-`));
  try {
    copyTree(copyRoot);
    mutation.mutate(copyRoot);
    const testPath = join(copyRoot, mutation.test);
    if (!existsSync(testPath)) throw new Error(`focused test missing: ${mutation.test}`);
    const args = ['--test', '--test-force-exit', '--test-timeout=30000'];
    if (mutation.testNamePattern) args.push(`--test-name-pattern=${mutation.testNamePattern}`);
    args.push(testPath);
    const result = spawnSync(process.execPath, args, {
      cwd: copyRoot,
      encoding: 'utf8',
      env: process.env,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) {
      throw new Error(`deletion test unexpectedly survived: ${mutation.name}`);
    }
    if (!output.includes(mutation.expected)) {
      throw new Error(
        `deletion test ${mutation.name} failed without signature '${mutation.expected}'\n${output.slice(-4000)}`,
      );
    }
    console.log(`ok ${mutation.name}`);
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
}

const requested = process.argv.slice(2);
const selected = requested.length ? W1.filter((mutation) => requested.includes(mutation.name)) : W1;
if (requested.length && selected.length !== requested.length) {
  const known = new Set(W1.map((mutation) => mutation.name));
  const unknown = requested.filter((name) => !known.has(name));
  throw new Error(`unknown deletion mutation: ${unknown.join(', ')}`);
}
for (const mutation of selected) runMutation(mutation);
console.log('annotated-text composition deletion tests: ok');
