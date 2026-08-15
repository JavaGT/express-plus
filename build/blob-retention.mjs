// blob-retention.ts — S6/A5 named retention policies, evaluated centrally
// (workbench#94, epic scope#23). One module owns the five named policies'
// defaults + evaluation; nothing else hardcodes a blob TTL literal.
//
// The five policies (#20/#21):
//   - abandoned-upload: a staged upload never claimed by a committed dispatch
//     is reaped after this TTL (the blob store's orphan sweep + the
//     pending-blob claim expiry).
//   - replaced-generation: the recoverable window a REPLACED generation's
//     bytes stay readable after the owning reference switched to a new
//     generation (#13/#14) — before the reaper may reclaim them.
//   - deleted-file: how long deleted live bytes wait before the cleanup sweep
//     removes them. The S1/A6 recycle window (default 7 days) protects the
//     backup-held copies; the live bytes are the framework's sweep, scheduled
//     here. 0 = immediate, the default.
//   - privacy-erasure: the erasure-class deletion wait. Delete is ONE concept
//     (owner decision #4) — erasure flows through the same recycling-bin path,
//     so this policy exists as a named, configurable knob (default 0, the
//     erasure takes the recycle bin's recoverable window for backup copies).
//   - backup-retention: how long retained backups hold generation copies
//     before the backup manager trims them. The backup manager (S1/A3) is
//     app-owned; this module declares the policy's default centrally so a
//     backup manager can read it instead of hardcoding a TTL.








export const BLOB_RETENTION_POLICY_NAMES                                     = Object.freeze([
  'abandoned-upload',
  'replaced-generation',
  'deleted-file',
  'privacy-erasure',
  'backup-retention',
]);

// The named policy → config-key mapping. The policy NAMES are the spec's
// vocabulary (#20/#21); the config object keys are camelCase. The evaluator
// maps one to the other so a caller can ask for a policy by its name.
const POLICY_KEY                                                               = {
  'abandoned-upload': 'abandonedUploadTtlMs',
  'replaced-generation': 'replacedGenerationRetentionMs',
  'deleted-file': 'deletedFileCleanupMs',
  'privacy-erasure': 'privacyErasureMs',
  'backup-retention': 'backupRetentionMs',
};














export const blobRetentionDefaults                                  = Object.freeze({
  // 1h — the historical framework orphan-sweep TTL, now a named policy.
  abandonedUploadTtlMs: 60 * 60_000,
  // 7d — mirrors the S1/A6 default recycle recovery window: a replaced
  // generation stays readable/restorable for the same recoverable period.
  replacedGenerationRetentionMs: 7 * 86_400_000,
  // Deleted live bytes are swept immediately; backup copies get the recycle
  // bin's recoverable window, not a second live-store wait.
  deletedFileCleanupMs: 0,
  // Erasure is the same delete path (owner decision #4); no separate live wait.
  privacyErasureMs: 0,
  // 30d — declared centrally so the app-owned backup manager can read it.
  backupRetentionMs: 30 * 86_400_000,
});

/**
 * Validate + normalize a (possibly partial) named-policies override against
 * the defaults. Every policy must be a finite, non-negative millisecond
 * number; unknown policy names are rejected. Returns the frozen, fully-filled
 * policies object (the shared defaults reference when no override is given).
 */
export function validateBlobRetentionPolicies(
  policies                                           ,
)                                  {
  if (policies === undefined) return blobRetentionDefaults;
  if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) {
    throw new TypeError('blobRetention must be an object of named retention policies');
  }
  // Config keys are the camelCase policy keys; anything else is a typo and is
  // rejected (fail closed, never silently ignored).
  const validKeys = BLOB_RETENTION_POLICY_NAMES.map((name) => POLICY_KEY[name]);
  for (const key of Object.keys(policies)                                   ) {
    if (!validKeys.includes(key)) {
      throw new TypeError(`unknown blob retention policy '${key}' — expected one of ${validKeys.join(', ')}`);
    }
  }
  for (const name of BLOB_RETENTION_POLICY_NAMES) {
    const value = policies[POLICY_KEY[name]];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new TypeError(`blobRetention.${POLICY_KEY[name]} must be a finite non-negative number (ms)`);
    }
  }
  return Object.freeze({
    abandonedUploadTtlMs: policies.abandonedUploadTtlMs ?? blobRetentionDefaults.abandonedUploadTtlMs,
    replacedGenerationRetentionMs: policies.replacedGenerationRetentionMs ?? blobRetentionDefaults.replacedGenerationRetentionMs,
    deletedFileCleanupMs: policies.deletedFileCleanupMs ?? blobRetentionDefaults.deletedFileCleanupMs,
    privacyErasureMs: policies.privacyErasureMs ?? blobRetentionDefaults.privacyErasureMs,
    backupRetentionMs: policies.backupRetentionMs ?? blobRetentionDefaults.backupRetentionMs,
  });
}

/**
 * The single central evaluator: one named policy → its effective millisecond
 * value, fail-closed on a malformed (or missing, after validation) value.
 */
export function retentionMs(policies                                 , name                         )         {
  const value = policies[POLICY_KEY[name]];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`blob retention policy '${name}' must evaluate to a finite non-negative number of ms`);
  }
  return value;
}
