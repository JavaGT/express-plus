import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the packed package typechecks a strict consumer without ambient shims', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'workbench-public-types-'));
  try {
    const [{ filename }] = JSON.parse(execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', consumer],
      { cwd: root, encoding: 'utf8' },
    ));
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-package-lock', join(consumer, filename)],
      { cwd: consumer, stdio: 'pipe' },
    );
    copyFileSync(join(root, 'type-test/public-api.ts'), join(consumer, 'public-api.ts'));
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        types: ['node'],
        typeRoots: [join(root, 'node_modules/@types')],
      },
      files: ['public-api.ts'],
    }));

    let failure = null;
    try {
      execFileSync(
        join(root, 'node_modules/.bin/tsc'),
        ['--project', join(consumer, 'tsconfig.json')],
        { cwd: consumer, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      failure = error;
    }
    assert.equal(failure, null, failure?.stdout || failure?.stderr || 'typecheck failed');
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
