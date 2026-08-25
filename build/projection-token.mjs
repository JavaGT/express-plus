// Recipient visibility ledger + projection tokens (#122 design §8).
//
// A bounded, server-held record of which (branch, entity, id) fragments a
// specific recipient has PROVENLY received at a given composite cursor. The
// token is the recipient's opaque handle on one ledger entry: random,
// principal-bound, scope-bound, declaration-version-bound, and expiring.
// Removals may cite only rows an entry proves were delivered — a current-state
// authorization check alone could disclose an ID the recipient never saw
// (design §7).
//
// Token rotation RETAINS a short chain of predecessor entries (bounded per
// holder, insertion-order evicted like field-delta.ts createDeltaProjector):
// an SSE reconnect that presents the previous token after a patch was already
// accepted resolves against the retained predecessor instead of falling back
// to a full snapshot. Every other miss — absent, expired, evicted,
// foreign-principal, wrong declaration version, or cursor disagreement —
// resolves to nothing, and every "nothing" receives the identical
// snapshot-fallback treatment with no distinguishing oracle.
//
// All state is in-memory by design: server restart falls back to full
// snapshots (design §8), so there is no durable surface to persist and no
// second source of truth to drift.

import { randomUUID } from 'node:crypto';





























































const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_CHAIN_LENGTH = 3;

function holderKeyOf(principal         , scope        , planVersion        )         {
  const candidate = principal                                                       ;
  return `${String(candidate?.type ?? '')}\u0000${String(candidate?.id ?? '')}\u0000${scope}\u0000${planVersion}`;
}

export function createProjectionLedger({ maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS, chainLength = DEFAULT_CHAIN_LENGTH, now = Date.now }                = {})                   {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive safe integer');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive safe integer');
  if (!Number.isSafeInteger(chainLength) || chainLength < 1) throw new TypeError('chainLength must be a positive safe integer');





  // Insertion-ordered token index; iteration order drives capacity eviction.
  const byToken = new Map                   ();
  // Retained predecessor chains per holder, newest LAST.
  const chains = new Map                  ();

  function dropToken(token        )       {
    const entry = byToken.get(token);
    if (!entry) return;
    byToken.delete(token);
    const chain = chains.get(entry.holderKey);
    if (chain) {
      const index = chain.indexOf(token);
      if (index !== -1) chain.splice(index, 1);
      if (chain.length === 0) chains.delete(entry.holderKey);
    }
  }

  function evictExpired()       {
    const stamp = now();
    for (const [token, entry] of byToken) {
      if (entry.expiresAt <= stamp) dropToken(token);
    }
  }

  function evictOverflow()       {
    while (byToken.size > maxEntries) dropToken(byToken.keys().next().value          );
  }

  function register({ principal, scope, planVersion, cursor, visible, addresses }                                             )                              {
    if (!Number.isSafeInteger(cursor.anchor) || !Number.isSafeInteger(cursor.composite)) throw new TypeError('ledger cursor must be safe integers');
    evictExpired();
    const holderKey = holderKeyOf(principal, scope, planVersion);
    const token = `wbpt_${randomUUID().replaceAll('-', '')}`;
    byToken.set(token, {
      token, holderKey, scope, planVersion,
      cursor: Object.freeze({ ...cursor }),
      visible,
      ...(addresses ? { addresses } : {}),
      expiresAt: now() + ttlMs,
    });
    let chain = chains.get(holderKey);
    if (!chain) chains.set(holderKey, chain = []);
    chain.push(token);
    while (chain.length > chainLength) dropToken(chain[0]);
    evictOverflow();
    return Object.freeze({ projectionToken: token });
  }

  function resolve({ token, principal, scope, planVersion, cursor }                                            )                     {
    if (typeof token !== 'string' || token.length === 0) return null;
    evictExpired();
    const entry = byToken.get(token);
    if (!entry) return null;
    if (entry.holderKey !== holderKeyOf(principal, scope, planVersion)) return null;
    // Token/cursor agreement is mandatory: a real token presented beside a
    // cursor it never proved is reuse under a different position (design §8).
    if (entry.cursor.anchor !== cursor.anchor || entry.cursor.composite !== cursor.composite) return null;
    const { expiresAt: _expiresAt, ...publicEntry } = entry;
    return publicEntry;
  }

  function clear()       {
    byToken.clear();
    chains.clear();
  }

  function size()         {
    evictExpired();
    return byToken.size;
  }

  return Object.freeze({ register, resolve, clear, size });
}
