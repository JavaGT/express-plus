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
import type { CompositeCursorV1 } from './composite-patch-envelope.ts';

export interface LedgerEntry {
  readonly token: string;
  readonly holderKey: string;
  readonly scope: string;
  /** Declaration-version hash the projected state was produced against. */
  readonly planVersion: string;
  readonly cursor: CompositeCursorV1;
  /** Proven-received fragments: branchId -> entity -> Set<id>. */
  readonly visible: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * Proven keyed-ancestor addresses (#157): compositeFragmentAddressKey ->
   * keyed member ids above the fragment's own relation. Lets a later removal
   * under a keyed ancestor patch exactly instead of falling back to a full
   * snapshot. Empty for legacy entries; absence degrades to the old
   * fail-closed behavior, never to a guessed path.
   */
  readonly addresses?: ReadonlyMap<string, readonly string[]>;
}

export interface ProjectionLedger {
  /**
   * Register a freshly projected state (bootstrap or accepted patch) and mint
   * its opaque token. Each registration appends to the holder's retained
   * predecessor chain; older entries stay resolvable until the chain bound,
   * TTL, or global capacity evicts them.
   */
  register(input: {
    principal: unknown;
    scope: string;
    planVersion: string;
    cursor: CompositeCursorV1;
    visible: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
    /** Keyed-ancestor addresses of the projected fragments (#157). */
    addresses?: ReadonlyMap<string, readonly string[]>;
  }): { projectionToken: string };
  /**
   * Resolve a presented token. Returns the entry only when it exists, is
   * unexpired, and matches principal/scope/planVersion/cursor exactly.
   */
  resolve(input: {
    token: string;
    principal: unknown;
    scope: string;
    planVersion: string;
    cursor: CompositeCursorV1;
  }): LedgerEntry | null;
  clear(): void;
  size(): number;
}

interface LedgerOptions {
  /** Global insertion-order capacity across all holders. */
  maxEntries?: number;
  ttlMs?: number;
  /** Retained predecessor entries per (principal, scope, planVersion). */
  chainLength?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_CHAIN_LENGTH = 3;

function holderKeyOf(principal: unknown, scope: string, planVersion: string): string {
  const candidate = principal as { type?: unknown; id?: unknown } | null | undefined;
  return `${String(candidate?.type ?? '')}\u0000${String(candidate?.id ?? '')}\u0000${scope}\u0000${planVersion}`;
}

export function createProjectionLedger({ maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS, chainLength = DEFAULT_CHAIN_LENGTH, now = Date.now }: LedgerOptions = {}): ProjectionLedger {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive safe integer');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive safe integer');
  if (!Number.isSafeInteger(chainLength) || chainLength < 1) throw new TypeError('chainLength must be a positive safe integer');

  interface LiveEntry extends LedgerEntry {
    expiresAt: number;
  }

  // Insertion-ordered token index; iteration order drives capacity eviction.
  const byToken = new Map<string, LiveEntry>();
  // Retained predecessor chains per holder, newest LAST.
  const chains = new Map<string, string[]>();

  function dropToken(token: string): void {
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

  function evictExpired(): void {
    const stamp = now();
    for (const [token, entry] of byToken) {
      if (entry.expiresAt <= stamp) dropToken(token);
    }
  }

  function evictOverflow(): void {
    while (byToken.size > maxEntries) dropToken(byToken.keys().next().value as string);
  }

  function register({ principal, scope, planVersion, cursor, visible, addresses }: Parameters<ProjectionLedger['register']>[0]): { projectionToken: string } {
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

  function resolve({ token, principal, scope, planVersion, cursor }: Parameters<ProjectionLedger['resolve']>[0]): LedgerEntry | null {
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

  function clear(): void {
    byToken.clear();
    chains.clear();
  }

  function size(): number {
    evictExpired();
    return byToken.size;
  }

  return Object.freeze({ register, resolve, clear, size });
}
