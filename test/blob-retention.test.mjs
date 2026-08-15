// blob-retention.test.mjs — S6/A5 named retention policies (workbench#94):
// the five policies are centrally configurable with defaults, evaluated by
// name, and reject malformed overrides. No scattered TTL literals.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blobRetentionDefaults,
  validateBlobRetentionPolicies,
  retentionMs,
  BLOB_RETENTION_POLICY_NAMES,
} from '../build/blob-retention.mjs';
import { maintenanceDefaults } from '../build/application-runtime.mjs';
import workbench from '../build/index.mjs';

test('the five named retention policies ship with frozen defaults', () => {
  assert.deepStrictEqual(BLOB_RETENTION_POLICY_NAMES, [
    'abandoned-upload',
    'replaced-generation',
    'deleted-file',
    'privacy-erasure',
    'backup-retention',
  ]);
  assert.deepStrictEqual(blobRetentionDefaults, {
    abandonedUploadTtlMs: 60 * 60_000,
    replacedGenerationRetentionMs: 7 * 86_400_000,
    deletedFileCleanupMs: 0,
    privacyErasureMs: 0,
    backupRetentionMs: 30 * 86_400_000,
  });
  assert.ok(Object.isFrozen(blobRetentionDefaults), 'the defaults are frozen');
});

test('a partial override is filled from the defaults; validation is per policy', () => {
  const overridden = validateBlobRetentionPolicies({ replacedGenerationRetentionMs: 1_000 });
  assert.equal(overridden.replacedGenerationRetentionMs, 1_000, 'the override wins');
  assert.equal(overridden.abandonedUploadTtlMs, blobRetentionDefaults.abandonedUploadTtlMs, 'unset policies keep the default');
  assert.ok(Object.isFrozen(overridden));
  // No override → the shared defaults reference (so maintenance deep-equals cleanly).
  assert.equal(validateBlobRetentionPolicies(), blobRetentionDefaults);
});

test('malformed policy overrides are rejected', () => {
  assert.throws(() => validateBlobRetentionPolicies(null), /blobRetention must be an object/);
  assert.throws(() => validateBlobRetentionPolicies([]), /blobRetention must be an object/);
  assert.throws(() => validateBlobRetentionPolicies({ replacedGenerationRetentionMs: -1 }), /replacedGenerationRetentionMs must be a finite non-negative number/);
  assert.throws(() => validateBlobRetentionPolicies({ replacedGenerationRetentionMs: Number.NaN }), /replacedGenerationRetentionMs/);
  assert.throws(() => validateBlobRetentionPolicies({ abandonedUploadTtlMs: '1h' }), /abandonedUploadTtlMs/);
  assert.throws(() => validateBlobRetentionPolicies({ unknownPolicyMs: 1000 }), /unknown blob retention policy 'unknownPolicyMs'/);
});

test('retentionMs evaluates a policy by name and fails closed on a malformed value', () => {
  const policies = validateBlobRetentionPolicies({ backupRetentionMs: 5_000 });
  assert.equal(retentionMs(policies, 'backup-retention'), 5_000);
  assert.equal(retentionMs(blobRetentionDefaults, 'replaced-generation'), 7 * 86_400_000);
  assert.equal(retentionMs(blobRetentionDefaults, 'abandoned-upload'), 60 * 60_000);
  // A caller bypassing validation with a broken value gets a fail-closed throw.
  assert.throws(() => retentionMs({ ...blobRetentionDefaults, replacedGenerationRetentionMs: -5 }, 'replaced-generation'), /replaced-generation/);
});

test('workbench() carries the named policies + low-disk headroom into _maintenance', async () => {
  const app = workbench({ blobRetention: { replacedGenerationRetentionMs: 123_000 }, blobLowDiskHeadroomBytes: 42 });
  assert.equal(app._maintenance.blobRetention.replacedGenerationRetentionMs, 123_000);
  assert.equal(app._maintenance.blobRetention.abandonedUploadTtlMs, blobRetentionDefaults.abandonedUploadTtlMs);
  assert.equal(app._maintenance.blobLowDiskHeadroomBytes, 42);
  assert.equal(maintenanceDefaults.blobRetention, blobRetentionDefaults, 'the maintenance default is the named-policy default set');
  await app.shutdown();
});

test('workbench() rejects malformed named-policy config', () => {
  assert.throws(() => workbench({ blobRetention: { replacedGenerationRetentionMs: -1 } }), /replacedGenerationRetentionMs/);
  assert.throws(() => workbench({ blobLowDiskHeadroomBytes: -1 }), /blobLowDiskHeadroomBytes/);
});
