import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// This is the intentionally supported package surface. Runtime exports may be
// wider while the migration is in progress; additions here are promises to
// consumers and therefore require both runtime and strict-TypeScript coverage.
export const PUBLIC_API = Object.freeze({
  workbench: Object.freeze({
    default: true,
    named: Object.freeze([
      'action', 'event', 'entity', 'scope',
      'text', 'boolean', 'date', 'number', 'json', 'ref', 'hash', 'blob',
      'link', 'map', 'list', 'log', 'ephemeral', 'state', 'computed',
      'projected', 'raster', 'polyline', 'vector',
      'owner', 'membership', 'read', 'write', 'subscribe', 'admin',
      'grant', 'deny', 'everyone', 'never', 'anyOf', 'inherit',
      'principal', 'anonymous', 'requireUser', 'allowAnonymous', 'router',
      'inc', 'dec', 'self', 'many', 'effect', 'schedule', 'tick',
      'simulate', 'now',
      'User', 'Session', 'Inbox', 'Credential', 'Invitation', 'ApiKey',
      'TwoFactor',
    ]),
  }),
  'workbench/server': Object.freeze({
    default: false,
    named: Object.freeze([
      'sessionCookie', 'sessionPrincipalOf', 'sessionTokenOf',
      'apiKeyPrincipalOf', 'parseCookies', 'SESSION_COOKIE',
      'createInvitationApi', 'emailSeam', 'noopTransport',
      'matchRoute', 'serveStatic', 'createJobQueue', 'createBlobStore',
      'runMigrations', 'frameworkTableNames', 'declaredTableNames',
      'readCommittedCursor', 'createLiveDelivery',
    ]),
  }),
  'workbench/client': Object.freeze({
    default: false,
    named: Object.freeze([
      'LiveChannel', 'LiveList', 'WorkbenchFailureError', 'decodeResult', 'createLiveStore',
      'createScopeLiveStore', 'createLiveDeliverySession',
      'createAuthClient',
    ]),
  }),
});

const PRIVATE_ENTRYPOINTS = Object.freeze([
  'workbench/internal',
]);

const root = fileURLToPath(new URL('..', import.meta.url));

test('the packed package exposes the supported runtime contract', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'workbench-public-contract-'));
  try {
    const packJson = execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', consumer],
      { cwd: root, encoding: 'utf8' },
    );
    const [{ filename }] = JSON.parse(packJson);
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-package-lock', join(consumer, filename)],
      { cwd: consumer, stdio: 'pipe' },
    );

    writeFileSync(join(consumer, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(consumer, 'verify.mjs'),
      `const manifest = ${JSON.stringify(PUBLIC_API)};\n`
        + `for (const [entrypoint, contract] of Object.entries(manifest)) {\n`
        + `  const module = await import(entrypoint);\n`
        + `  if (contract.default && typeof module.default !== 'function') {\n`
        + `    throw new Error(entrypoint + ' must export a default function');\n`
        + `  }\n`
        + `  for (const symbol of contract.named) {\n`
        + `    if (!(symbol in module)) throw new Error(entrypoint + ' is missing ' + symbol);\n`
        + `  }\n`
        + `}\n`
        + `for (const entrypoint of ${JSON.stringify(PRIVATE_ENTRYPOINTS)}) {\n`
        + `  try {\n`
        + `    await import(entrypoint);\n`
        + `  } catch (error) {\n`
        + `    if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;\n`
        + `    throw error;\n`
        + `  }\n`
        + `  throw new Error(entrypoint + ' must not be exported');\n`
        + `}\n`,
    );

    let failure = null;
    try {
      execFileSync('node', ['verify.mjs'], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failure = error;
    }
    assert.equal(
      failure,
      null,
      failure ? readFileSync(join(consumer, 'verify.mjs'), 'utf8') + '\n' + failure.stderr : '',
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
