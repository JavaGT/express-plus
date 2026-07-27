// Transactionally declared post-commit work. Declarations join the mutation
// transaction, but Workbench never performs their external I/O. A privileged
// application-owned runner claims immutable descriptors after commit.

const STATUS_PENDING = 'pending';
const STATUS_CLAIMED = 'claimed';
const STATUS_COMPLETED = 'completed';

function json(value, where) {
  try { return JSON.stringify(value); } catch { throw new TypeError(`${where} must be JSON-serializable`); }
}

function assertText(value, where) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${where} must be a non-empty string`);
  return value;
}

function normalizeEffects(effects) {
  if (effects === undefined) return [];
  if (!Array.isArray(effects)) throw new TypeError('registered action effects must be an array');
  return effects.map((effect, ordinal) => {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) throw new TypeError(`registered action effect ${ordinal} must be an object`);
    const file = assertText(effect.file, `registered action effect ${ordinal}.file`);
    const operation = assertText(effect.operation, `registered action effect ${ordinal}.operation`);
    const key = effect.key === undefined ? file : assertText(effect.key, `registered action effect ${ordinal}.key`);
    const verification = assertText(effect.verification, `registered action effect ${ordinal}.verification`);
    const payload = effect.payload ?? null;
    json(payload, `registered action effect ${ordinal}.payload`);
    return Object.freeze({ file, operation, key, verification, payload, ordinal });
  });
}

export function postCommitEffect(input) {
  return Object.freeze({
    file: assertText(input?.file, 'postCommitEffect.file'),
    operation: assertText(input?.operation, 'postCommitEffect.operation'),
    key: input?.key === undefined ? assertText(input?.file, 'postCommitEffect.file') : assertText(input.key, 'postCommitEffect.key'),
    verification: assertText(input?.verification, 'postCommitEffect.verification'),
    payload: input?.payload ?? null,
  });
}

export function declarePostCommitEffectsInTxn(db, { scope, actionId, committedAt, privateFact, effects }) {
  const declared = normalizeEffects(effects);
  if (privateFact === undefined && declared.length === 0) return;
  const factJson = json(privateFact ?? null, 'registered action privateFact');
  const canonicalFact = JSON.parse(factJson);
  if (declared.length > 0 && (
    !canonicalFact || typeof canonicalFact !== 'object' || Array.isArray(canonicalFact)
    || !Object.prototype.hasOwnProperty.call(canonicalFact, 'before')
    || !Object.prototype.hasOwnProperty.call(canonicalFact, 'after')
  )) {
    throw new TypeError('registered action effects require a privateFact with before and after properties');
  }
  const effectsJson = JSON.stringify(declared);
  const fact = db.prepare(
    `INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects)
     VALUES (?, ?, ?, ?, ?)
     RETURNING originOrder`,
  ).get(scope, actionId, committedAt, factJson, effectsJson);
  const insert = db.prepare(
    `INSERT INTO _PostCommitEffect
      (scope, actionId, file, operation, ordinal, originOrder, exclusionKey, verification, payload, declaredAt, status, fence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  for (const effect of declared) {
    insert.run(scope, actionId, effect.file, effect.operation, effect.ordinal, fact.originOrder, effect.key,
      effect.verification, JSON.stringify(effect.payload), committedAt, STATUS_PENDING);
  }
}

function parse(row) {
  if (!row) return null;
  return Object.freeze({
    id: Object.freeze({ scope: row.scope, actionId: row.actionId, file: row.file, operation: row.operation, ordinal: row.ordinal }),
    key: row.exclusionKey,
    verification: row.verification,
    payload: JSON.parse(row.payload),
    fence: row.fence,
    leaseUntil: row.leaseUntil,
  });
}

function identityWhere() {
  return 'scope = :scope AND actionId = :actionId AND file = :file AND operation = :operation AND ordinal = :ordinal';
}

function identityParams(id) {
  if (!id || typeof id !== 'object') throw new TypeError('effect id is required');
  return {
    scope: assertText(id.scope, 'effect id.scope'), actionId: assertText(id.actionId, 'effect id.actionId'),
    file: assertText(id.file, 'effect id.file'), operation: assertText(id.operation, 'effect id.operation'),
    ordinal: id.ordinal,
  };
}

export function createPostCommitEffectRunner({ db, leaseMs = 30_000, now = () => Date.now() } = {}) {
  if (!db) throw new Error('createPostCommitEffectRunner: db is required');
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be a positive safe integer');

  function claim(workerId) {
    assertText(workerId, 'workerId');
    const at = now();
    const row = db.prepare(
      `UPDATE _PostCommitEffect
       SET status = ?, workerId = ?, leaseUntil = ?, fence = fence + 1
       WHERE declarationOrder = (
         SELECT candidate.declarationOrder FROM _PostCommitEffect candidate
         WHERE (candidate.status = ? OR (candidate.status = ? AND candidate.leaseUntil <= ?))
           AND (candidate.availableAt IS NULL OR candidate.availableAt <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM _PostCommitEffect earlier
             WHERE earlier.exclusionKey = candidate.exclusionKey
               AND (earlier.originOrder < candidate.originOrder
                 OR (earlier.originOrder = candidate.originOrder AND earlier.ordinal < candidate.ordinal))
               AND earlier.status != ?
           )
         ORDER BY candidate.originOrder, candidate.ordinal LIMIT 1
       )
       RETURNING *`,
    ).get(STATUS_CLAIMED, workerId, at + leaseMs, STATUS_PENDING, STATUS_CLAIMED, at, at, STATUS_COMPLETED);
    return parse(row);
  }

  function heartbeat(id, workerId, fence) {
    const at = now();
    const params = { ...identityParams(id), workerId: assertText(workerId, 'workerId'), fence, at, leaseUntil: at + leaseMs };
    return db.prepare(
      `UPDATE _PostCommitEffect SET leaseUntil = :leaseUntil
       WHERE ${identityWhere()} AND status = 'claimed' AND workerId = :workerId AND fence = :fence AND leaseUntil > :at`,
    ).run(params).changes > 0;
  }

  function complete(id, workerId, fence, { verification } = {}) {
    const identity = identityParams(id);
    const current = db.prepare(`SELECT status, workerId, fence, verification FROM _PostCommitEffect WHERE ${identityWhere()}`).get(identity);
    if (!current) return { accepted: false };
    if (verification !== current.verification) return { accepted: false, verification: false };
    if (current.status === STATUS_COMPLETED) {
      return current.workerId === workerId && current.fence === fence
        ? { accepted: true, noop: true }
        : { accepted: false };
    }
    const at = now();
    const params = { ...identity, workerId: assertText(workerId, 'workerId'), fence, at, completedAt: at, verification };
    const changed = db.prepare(
      `UPDATE _PostCommitEffect SET status = 'completed', completedAt = :completedAt, leaseUntil = NULL
       WHERE ${identityWhere()} AND status = 'claimed' AND workerId = :workerId AND fence = :fence
         AND leaseUntil > :at AND verification = :verification`,
    ).run(params).changes;
    return changed > 0 ? { accepted: true, noop: false } : { accepted: false };
  }

  function fail(id, workerId, fence, { retryAt = now() } = {}) {
    if (!Number.isFinite(retryAt)) throw new TypeError('retryAt must be a finite epoch time');
    const at = now();
    const params = { ...identityParams(id), workerId: assertText(workerId, 'workerId'), fence, at, retryAt };
    const changed = db.prepare(
      `UPDATE _PostCommitEffect
       SET status = 'pending', workerId = NULL, leaseUntil = NULL, availableAt = :retryAt
       WHERE ${identityWhere()} AND status = 'claimed' AND workerId = :workerId AND fence = :fence AND leaseUntil > :at`,
    ).run(params).changes;
    return { accepted: changed > 0 };
  }

  // Rebuild missing declarations from private canonical facts. Existing rows,
  // including completion/fence state, are never overwritten. This performs no I/O.
  function reconstruct() {
    const facts = db.prepare('SELECT * FROM _PrivateActionFact ORDER BY originOrder').all();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO _PostCommitEffect
       (scope, actionId, file, operation, ordinal, originOrder, exclusionKey, verification, payload, declaredAt, status, fence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
    );
    let inserted = 0;
    for (const fact of facts) {
      for (const effect of normalizeEffects(JSON.parse(fact.effects))) {
        inserted += Number(insert.run(fact.scope, fact.actionId, effect.file, effect.operation, effect.ordinal, fact.originOrder,
          effect.key, effect.verification, JSON.stringify(effect.payload), fact.committedAt).changes);
      }
    }
    return { inserted };
  }

  return Object.freeze({ claim, heartbeat, complete, fail, reconstruct });
}
