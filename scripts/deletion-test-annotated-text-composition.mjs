// Temporary-copy deletion harness for the composite annotated-text seam
// (scope#992 Finding 8). Mutates copies only; the worktree is never edited.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  {
    name: 'remove-v15-normalizer',
    expected: 'v15 fixture did not reach canonical reducer',
    test: 'test/annotated-text-operated-normalization.test.mjs',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/annotated-text-operated-event.mjs');
      const source = readFileSync(path, 'utf8');
      // The v15 dispatch guard appears as `if (version === 15) {` (committed
      // W1) or `if (version === 15 || version === 16) {` (in-flight W1 lanes);
      // the mutation must remove the v15 normalizer branch either way.
      const needle = /if \(version === 15(?:\s*\|\|\s*version === 16)?\) \{/;
      const match = source.match(needle);
      if (!match) throw new Error('v15 normalizer case is missing');
      const replacement = `if (version === 15) {
    throw new Error(\`\${entity}.\${field}.operated event version 15 is not supported\`);
  }
  if (false) {`;
      writeFileSync(path, source.replace(match[0], replacement));
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
  {
    name: 'remove-operation-declaration',
    expected: 'undeclared annotated operation was admitted',
    test: 'test/annotated-text-composite-deletion.test.mjs',
    testNamePattern: 'undeclared operation remains undeclared',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/kernel.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'const operations = declaration.operations === undefined ? [] : declaration.operations;';
      if (!source.includes(needle)) throw new Error('operations declaration read is missing');
      writeFileSync(path, source.replace(needle, 'const operations = [];'));
    },
  },
  {
    name: 'bypass-field-readmission',
    expected: 'revoked field writer committed composite operation',
    test: 'test/annotated-text-composite-deletion.test.mjs',
    testNamePattern: 'revoked field writer is denied',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/annotated-text-region-operation.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = /await authorizeFieldOp\(\{ name: handle\.entity, fields \}/;
      if (!needle.test(source)) throw new Error('transaction-bound field admission call is missing');
      writeFileSync(path, source.replace(needle, 'await (async () => {})(); void ({ name: handle.entity, fields }'));
    },
  },
  {
    name: 'trust-returned-application-transition',
    expected: 'semantically divergent application fact was accepted',
    test: 'test/annotated-text-composite-deletion.test.mjs',
    testNamePattern: 'semantically divergent application fact is rejected',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/pipeline.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'if (canonicalJsonEqual(before, after)) {';
      if (!source.includes(needle)) throw new Error('origin transition differ gate is missing');
      writeFileSync(path, source.replace(needle, 'if (false && canonicalJsonEqual(before, after)) {'));
    },
  },
  {
    name: 'remove-compound-private-fact-canonicalizer',
    expected: 'valid compound envelope did not reach _PrivateActionFact',
    test: 'test/annotated-text-composite-deletion.test.mjs',
    testNamePattern: 'a valid compound envelope reaches',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/post-commit-effects.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'if (compoundKindOf(fact) !== null) {';
      if (!source.includes(needle)) throw new Error('compound canonicalPrivateFact branch is missing');
      writeFileSync(path, source.replace(needle, 'if (false && compoundKindOf(fact) !== null) {'));
    },
  },
  // ---- W1b v16 durable-witness mutations (#149 / #148 rev 2) ----
  {
    name: 'w1b-remove-v16-stored-canonicalizer',
    expected: 'stored v16 eventData must be canonical',
    test: 'test/annotated-text-operated-v16.test.mjs',
    testNamePattern: 'appendEvents admits only branded v16 envelopes',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/committed-log.mjs');
      const source = readFileSync(path, 'utf8');
      // Disables the brand admission branch entirely: the minted envelope then
      // falls through to plain stringify and lands NONCANONICAL in _Log. The
      // test's canonical-bytes assertion must fail with its signature.
      const needle = "if (data && typeof data === 'object' && !Array.isArray(data) && data.version === 16) {";
      if (!source.includes(needle)) throw new Error('v16 eventData gate is missing');
      writeFileSync(path, source.replace(
        needle,
        "if (false && data && typeof data === 'object' && !Array.isArray(data) && data.version === 16) {",
      ));
    },
  },
  {
    name: 'w1b-accept-v16-duplicate-key',
    // Disables BOTH duplicate-key layers (strict scanner + byte-identity
    // reserialize). With either one alive the fixture still rejects, so the
    // mutation only "counts" when the malformed-bytes test goes green —
    // proving last-key-wins acceptance can never slip through.
    expected: 'malformed stored bytes fail closed',
    test: 'test/annotated-text-operated-v16.test.mjs',
    testNamePattern: 'malformed stored bytes fail closed',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/annotated-text-operated-event.mjs');
      const source = readFileSync(path, 'utf8');
      const scannerNeedle = "if (seen.has(key)) fail('duplicate-key');";
      if (!source.includes(scannerNeedle)) throw new Error('duplicate-key scanner check is missing');
      let next = source.replace(scannerNeedle, "if (false && seen.has(key)) fail('duplicate-key');");
      const reserNeedle = 'if (reserialized !== eventDataText) {';
      if (!next.includes(reserNeedle)) throw new Error('canonical reserialize check is missing');
      next = next.replace(reserNeedle, 'if (false && reserialized !== eventDataText) {');
      writeFileSync(path, next);
    },
  },
  {
    name: 'w1b-remove-v16-witness-completeness',
    expected: 'tampered witness fields reject with zero writes',
    test: 'test/annotated-text-operated-v16.test.mjs',
    testNamePattern: 'tampered witness fields reject with zero writes',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/entity/projection.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'if (JSON.stringify(closure) !== JSON.stringify(canonical.witnessBefore)) {';
      if (!source.includes(needle)) throw new Error('before-witness equality check is missing');
      writeFileSync(path, source.replace(needle, 'if (false && JSON.stringify(closure) !== JSON.stringify(canonical.witnessBefore)) {'));
    },
  },
  {
    name: 'w1b-omit-reverse-protector',
    // With pruning disabled the planner's own completeness gate rejects the
    // dangling edge before any event exists — defense-in-depth in action.
    expected: 'region witness disagrees with operated event',
    test: 'test/annotated-text-operated-v16.test.mjs',
    testNamePattern: 'topology-changing committed event is ordinary v16',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/annotated-text-region-reducer.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'function pruneRemovedTargets(images';
      if (!source.includes(needle)) throw new Error('dangling-edge pruning is missing');
      writeFileSync(path, source.replace(
        needle,
        'function pruneRemovedTargets(images',
      ).replace(
        "if (!image.protectedTargetIds.some((targetId) => removedIds.has(targetId))) return image;",
        'if (true) return image;',
      ));
    },
  },
  {
    name: 'w1b-trust-v16-resolved-offset',
    expected: 'forged after-digest writes nothing',
    test: 'test/annotated-text-region-postimage.test.mjs',
    testNamePattern: 'forged after-digest writes nothing',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/entity/projection.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'if (postimage.afterDigest !== canonical.afterDigest)';
      if (!source.includes(needle)) throw new Error('afterDigest verification is missing');
      writeFileSync(path, source.replace(needle, 'if (false && postimage.afterDigest !== canonical.afterDigest)'));
    },
  },
  {
    name: 'w1b-emit-v15-from-region-policy',
    // Rewires the compiled region policy to the retired v15 constructor; the
    // static no-v15-emitter assertion must fail with its exact message.
    expected: 'region policy must emit v16',
    test: 'test/annotated-text-operated-v16.test.mjs',
    testNamePattern: 'nothing new-emits them',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/annotated-text-region-operation.mjs');
      const source = readFileSync(path, 'utf8');
      // The v16 constructor call now carries an admission identity argument
      // (v16 lane in-flight); match the whole statement regardless of args.
      const needle = /const \{ event: envelope, capability \} = constructV16RegionEvent\(plan[\s\S]*?\}\);/;
      if (!needle.test(source)) throw new Error('v16 emission call is missing');
      writeFileSync(path, source
        .replace(needle, 'const envelope = constructV15RegionEvent(plan); void capability;')
        .replace("import { constructV16RegionEvent } from './annotated-text-operated-event.mjs';", "import { constructV15RegionEvent } from './annotated-text-operated-event.mjs';"));
    },
  },
{
    name: 'remove-contribution-policy',
    expected: 'compound action remained history eligible without its policy',
    test: 'test/annotated-text-composite-deletion.test.mjs',
    testNamePattern: 'a composed action is a history barrier when its contribution policy is removed',
    mutate(copyRoot) {
      const path = join(copyRoot, 'build/kernel.mjs');
      const source = readFileSync(path, 'utf8');
      const needle = 'policies: [...annotatedKernel.nativeInsertPolicies, ...compoundPolicies],';
      if (!source.includes(needle)) throw new Error('registry compound-policy assembly is missing');
      writeFileSync(path, source.replace(
        needle,
        'policies: [...annotatedKernel.nativeInsertPolicies],',
      ));
    },
  },
  {
    name: 'restore-legacy-classifier',
    expected: 'retired annotated history symbol remains: annotatedMove',
    kind: 'checker',
    test: 'scripts/check-annotated-text-single-authority.mjs',
    mutate(copyRoot) {
      const path = join(copyRoot, 'src/durable-history.ts');
      const source = readFileSync(path, 'utf8');
      if (/\bannotatedMove\b/.test(source)) throw new Error('retired symbol already present');
      writeFileSync(path, `${source}\n// restored legacy classifier (mutation fixture)\nconst annotatedMove = null;\n`);
    },
  },
  {
    name: 'import-legacy-privacy-into-history-move',
    expected: 'legacy annotated history privacy crossed read boundary: src/durable-history.ts',
    kind: 'checker',
    test: 'scripts/check-annotated-text-single-authority.mjs',
    mutate(copyRoot) {
      const path = join(copyRoot, 'src/durable-history.ts');
      const source = readFileSync(path, 'utf8');
      if (/assertLegacyAnnotatedHistoryReadable/.test(source)) throw new Error('privacy import already present');
      const needle = "export function createDurableHistoryRuntime(";
      if (!source.includes(needle)) throw new Error('durable runtime entry is missing');
      writeFileSync(path, source.replace(
        needle,
        "import { assertLegacyAnnotatedHistoryReadable } from './legacy-annotated-history-read-privacy.ts';\nexport function createDurableHistoryRuntime(",
      ));
    },
  },
];

function copyTree(copyRoot) {
  cpSync(join(root, 'build'), join(copyRoot, 'build'), { recursive: true });
  cpSync(join(root, 'public'), join(copyRoot, 'public'), { recursive: true });
  // #145 S6: copy the authored src + the single-authority checker so the
  // retire/boundary CI rules run against the mutated copy too.
  cpSync(join(root, 'src'), join(copyRoot, 'src'), { recursive: true });
  mkdirSync(join(copyRoot, 'scripts'), { recursive: true });
  cpSync(join(root, 'scripts/check-annotated-text-single-authority.mjs'), join(copyRoot, 'scripts/check-annotated-text-single-authority.mjs'));
  if (existsSync(join(root, 'index.d.ts'))) {
    cpSync(join(root, 'index.d.ts'), join(copyRoot, 'index.d.ts'));
  }
  const tests = [
    'test/annotated-text-operated-normalization.test.mjs',
    'test/annotated-text-operated-v16.test.mjs',
    'test/annotated-text-region-postimage.test.mjs',
    'test/annotated-text-snapshot-recovery-budget.test.mjs',
    'test/annotated-text-snapshot-cycle-budget-deletion.test.mjs',
    'test/annotated-text-authoring-fixture.mjs',
    'test/annotated-text-composite-deletion.test.mjs',
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
    if (mutation.kind === 'checker') {
      // The static single-authority gate is the "test": the injected retired
      // symbol / patience import must trip the retire/boundary rules.
      const checkerPath = join(copyRoot, 'scripts/check-annotated-text-single-authority.mjs');
      if (!existsSync(checkerPath)) throw new Error(`checker missing: ${checkerPath}`);
      const result = spawnSync(process.execPath, [checkerPath], {
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
      return;
    }
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
const selected = requested.length ? MUTATIONS.filter((mutation) => requested.includes(mutation.name)) : MUTATIONS;
if (requested.length && selected.length !== requested.length) {
  const known = new Set(MUTATIONS.map((mutation) => mutation.name));
  const unknown = requested.filter((name) => !known.has(name));
  throw new Error(`unknown deletion mutation: ${unknown.join(', ')}`);
}
for (const mutation of selected) runMutation(mutation);
console.log('annotated-text composition deletion tests: ok');
