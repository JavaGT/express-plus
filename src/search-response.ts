// search-response.ts — the S4/A6 search REQUEST/RESPONSE contract.
//
// The plugin contract (S4/A1, search-plugin.ts) defines what a plugin receives
// and returns; this module defines the PLATFORM-facing contract around it:
//
//   1. STALENESS DISCLOSURE — every returned result carries the authoritative
//      `{ pluginId, generation, staleness }` stamp (considerations #13/#8), so a
//      caller can disclose fresh/stale/rebuilding results instead of silently
//      presenting them as current. The stamp maps from the registry's health
//      state (`ready`→fresh, `stale`→stale, `building`→rebuilding,
//      `failed`→stale) and is always registry-derived — a plugin cannot spoof
//      its own health (S4/A1).
//   2. BOUNDED LIMITS — a request's result bound is clamped to a hard cap (max
//      results / page); nothing unbounded ever reaches the plugin (consideration
//      #22).
//   3. CANCELLATION + TIMEOUT — searchWithDeadline races a plugin's search
//      against the caller's AbortSignal and a hard deadline, returning a closed
//      cancelled/timed-out/completed outcome instead of a thrown state leak.
//   4. DETERMINISTIC TIE-BREAKING — equal ranks are ordered by a stable key;
//      the shared comparator is what the A4/A5 plugin implementations import.
//   5. FAIL CLOSED — a denied/policy-error/cancelled/timed-out search is a
//      response with ok:false and a closed reason, never a 500 leak (S5/A2
//      mirror).

import type { SearchPluginState } from './search-plugin.ts';

// The closed staleness vocabulary a response may disclose. `fresh` = the index
// reflects the source up to the current fence; `stale` = a source change
// invalidated the index but reconciliation has not consumed it; `rebuilding` =
// a materialization cycle is in progress (or nothing has materialized yet).
export type SearchStaleness = 'fresh' | 'stale' | 'rebuilding';

// Map the registry's health state to the disclosed staleness. `failed` maps to
// `stale`, never `fresh` and never `rebuilding`: a failed index is not current
// (stale) but nothing is actively materializing it either (not rebuilding). An
// unknown state — vocabulary this contract does not recognize — also maps to
// `stale` (fail closed: never claim freshness on a state we cannot vouch for).
export function searchStalenessOf(state: SearchPluginState): SearchStaleness {
  switch (state) {
    case 'ready': return 'fresh';
    case 'building': return 'rebuilding';
    case 'stale':
    case 'failed':
    default: return 'stale';
  }
}

// ---- bounded limits ----------------------------------------------------------

// The hard upper bound on any single search response's result count. A request
// cannot ask past this cap; the plugin never sees an unbounded result bound.
export const SEARCH_MAX_RESULTS_CAP = 1000;
// The hard upper bound on a single page's size.
export const SEARCH_MAX_PAGE_SIZE = 100;
// The default result bound when a request does not state one.
export const SEARCH_DEFAULT_LIMIT = 50;
// The default page size when a request pages without stating a size.
export const SEARCH_DEFAULT_PAGE_SIZE = 25;

// Clamp a requested result bound into the bounded range [1, cap]. A missing,
// non-finite, zero, or negative request collapses to the fallback — a bound of
// zero or less would mean "return nothing", which is a caller mistake, not a
// search feature, so it is refused rather than honored.
export function boundSearchLimit(
  requested: number | null | undefined,
  fallback: number = SEARCH_DEFAULT_LIMIT,
  cap: number = SEARCH_MAX_RESULTS_CAP,
): number {
  const value = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : Math.floor(fallback);
  return Math.max(1, Math.min(value, Math.max(1, Math.floor(cap))));
}

export interface SearchPageRequest {
  // A 1-based page number. When present, the window is paged: offset = (page-1)
  // * pageSize. Deterministic for every finite page.
  readonly page?: number;
  // The page size, clamped to [1, SEARCH_MAX_PAGE_SIZE].
  readonly pageSize?: number;
  // A flat result bound (alternative to paging), clamped to
  // [1, SEARCH_MAX_RESULTS_CAP].
  readonly limit?: number;
  // A flat offset (alternative to paging), clamped to >= 0.
  readonly offset?: number;
}

// Resolve a request's window to `{ offset, limit }`. Paging and flat
// limit/offset are mutually exclusive: a page request wins (the page is the
// bounded unit); otherwise the flat offset/limit apply. Both paths clamp so no
// window exceeds the caps.
export function searchPageWindow(request: SearchPageRequest): { readonly offset: number; readonly limit: number } {
  if (typeof request.page === 'number' && Number.isFinite(request.page) && request.page >= 1) {
    const page = Math.floor(request.page);
    const size = boundSearchLimit(request.pageSize, SEARCH_DEFAULT_PAGE_SIZE, SEARCH_MAX_PAGE_SIZE);
    const offset = Math.max(0, (page - 1) * size);
    return { offset, limit: size };
  }
  const offset = typeof request.offset === 'number' && Number.isFinite(request.offset) && request.offset > 0
    ? Math.floor(request.offset)
    : 0;
  return { offset, limit: boundSearchLimit(request.limit) };
}

// ---- deterministic tie-breaking ----------------------------------------------

// A plugin-provided relevance value: a numeric score (bm25 rank, cosine
// similarity) or a rank/score string. Missing and non-finite values sort AFTER
// every present finite value (deterministic, never a NaN comparison).
export type SearchRank = number | string | null | undefined;

// The ordering of the primary rank: 'asc' (FTS-style: lower is better) or
// 'desc' (vector-style: higher is better).
export type SearchOrder = 'asc' | 'desc';

// The numeric reading of a rank, or null when it is missing or non-finite. A
// numeric-string rank ('7') compares as the number 7, mirroring SQLite's text
// coercion; a non-numeric string ('ab') is not a score and falls back to the
// lexicographic ordering below.
function numericRank(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

// Compare two ranks deterministically. Present finite numeric ranks order by
// value in the requested direction; a missing/non-finite rank sorts after every
// present one in BOTH directions (inverting the order must not drag a missing
// rank above a real score); two missing ranks order by their raw forms
// lexicographically, so a fully unranked set is still deterministic.
export function compareSearchRanks(a: SearchRank, b: SearchRank, order: SearchOrder = 'asc'): number {
  const av = numericRank(a);
  const bv = numericRank(b);
  if (av !== null && bv !== null) {
    const diff = av === bv ? 0 : av < bv ? -1 : 1;
    return order === 'desc' ? -diff : diff;
  }
  if (av !== null) return -1;
  if (bv !== null) return 1;
  const as = a == null ? '' : String(a);
  const bs = b == null ? '' : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// The stable secondary identity a deterministic tie-break falls back to. The
// key must be unique within the plugin's index (a source row id, for example);
// with a unique key, the ordering is a TOTAL order regardless of sort stability.
export function compareSearchKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface SearchTieBreakOptions<THit> {
  readonly rankOf: (hit: THit) => SearchRank;
  readonly keyOf: (hit: THit) => string;
  readonly order?: SearchOrder;
}

// Order hits deterministically: primary rank (in the plugin's direction), then
// the stable key. The input is never mutated. This is the tie-break A4 (FTS
// rank) and A5 (vector similarity) share — same comparator, one direction each.
export function tieBreakSearchHits<THit>(
  hits: readonly THit[],
  options: SearchTieBreakOptions<THit>,
): THit[] {
  const order = options.order ?? 'asc';
  return [...hits].sort((a, b) => {
    const byRank = compareSearchRanks(options.rankOf(a), options.rankOf(b), order);
    if (byRank !== 0) return byRank;
    return compareSearchKeys(options.keyOf(a), options.keyOf(b));
  });
}

// ---- cancellation + timeout --------------------------------------------------

// The canonical cancelled search error. A plugin whose internal signal aborts
// (or a cooperative cancel path) throws this; the platform maps it to a
// cancelled response rather than an error leak.
export class SearchCancelledError extends Error {
  readonly name = 'SearchCancelledError';
  constructor(message = 'search cancelled') {
    super(message);
  }
}

// The canonical timeout search error, sibling to SearchCancelledError.
export class SearchTimeoutError extends Error {
  readonly name = 'SearchTimeoutError';
  constructor(message = 'search timed out') {
    super(message);
  }
}

// The closed outcome of a bounded/cancellable search run. `completed` carries
// the value; `cancelled` means the caller's signal aborted (or was already
// aborted before the run started); `timed-out` means the deadline elapsed. The
// run's own exceptions still throw — only cancellation and timeout are reduced
// to a closed outcome.
export type SearchDeadlineOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timed-out' };

export interface SearchDeadlineOptions {
  // The hard deadline in milliseconds. A non-positive/missing value disables
  // the timeout (the caller chooses an unbounded search).
  readonly timeoutMs?: number;
  // The caller's cancellation signal. An already-aborted signal cancels BEFORE
  // the run is invoked (a cancelled search never queries the plugin).
  readonly signal?: AbortSignal;
}

// Run a plugin search under the caller's cancellation signal and a hard
// deadline. `run` receives the combined AbortSignal so a cooperative plugin can
// stop work; aborting that signal does NOT throw — the outcome is the closed
// `cancelled`/`timed-out` value. The run is RACED against the deadline and the
// abort signal, so an uncooperative plugin (one that ignores the signal) cannot
// hang a timed-out or cancelled search — the outcome returns at the deadline /
// abort regardless of the plugin's cooperation. Any other exception from `run`
// propagates unchanged (the caller/registry owns failure isolation); a run that
// settles late (after the race already decided) is observed silently.
export async function searchWithDeadline<T>(
  run: (signal: AbortSignal) => T | Promise<T>,
  options: SearchDeadlineOptions = {},
): Promise<SearchDeadlineOutcome<T>> {
  // An already-aborted signal cancels BEFORE the run is invoked — a cancelled
  // search never queries the plugin.
  if (options.signal?.aborted) return { kind: 'cancelled' };

  const controller = new AbortController();

  const deadline = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The race arms: the run settles to a closed { completed | failed } value
  // (never rejects — a late rejection after the race decided must not surface
  // as an unhandled rejection), the deadline arm resolves when the timer fires,
  // and the abort arm resolves when the caller's signal fires.
  let fireDeadline: (() => void) | null = null;
  let fireOuterAbort: (() => void) | null = null;
  const deadlineArm = new Promise<void>((resolve) => { fireDeadline = resolve; });
  const abortArm = new Promise<void>((resolve) => { fireOuterAbort = resolve; });
  const onOuterAbortFire = () => {
    controller.abort();
    fireOuterAbort?.();
  };

  const runSettled = Promise.resolve().then(() => run(controller.signal))
    .then((value) => ({ kind: 'completed' as const, value }))
    .catch((err: unknown) => ({ kind: 'failed' as const, err }));

  const arms: Promise<
    SearchDeadlineOutcome<T> | { readonly kind: 'failed'; readonly err: unknown }
  >[] = [runSettled];
  if (deadline) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      fireDeadline?.();
    }, options.timeoutMs);
    arms.push(deadlineArm.then(() => ({ kind: 'timed-out' as const })));
  }
  if (options.signal !== undefined) {
    options.signal.addEventListener('abort', onOuterAbortFire, { once: true });
    arms.push(abortArm.then(() => ({ kind: 'cancelled' as const })));
  }

  try {
    const outcome = await Promise.race(arms);
    if (outcome.kind === 'failed') {
      const { err } = outcome;
      if (timedOut) return { kind: 'timed-out' };
      if (options.signal?.aborted) return { kind: 'cancelled' };
      if (controller.signal.aborted) return { kind: 'timed-out' };
      if (err instanceof SearchCancelledError) return { kind: 'cancelled' };
      if (err instanceof SearchTimeoutError) return { kind: 'timed-out' };
      throw err;
    }
    return outcome;
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbortFire);
  }
}

// ---- the response contract ---------------------------------------------------

// The per-result stamp every search result carries (spec 1): the plugin that
// produced it, the index generation it was produced from, and the disclosed
// staleness. Callers show the stamp so stale/rebuilding results are never
// silently presented as current.
export interface SearchResultStamp {
  readonly pluginId: string;
  readonly generation: number;
  readonly staleness: SearchStaleness;
}

// One returned search result: the platform stamp plus the plugin hit and its
// deterministic ordering identity. `key` is the stable, index-unique tie-break
// identity; `rank` is the plugin's relevance value. `excerpt` is present only
// when the excerpt's source field admitted (S4/A6: no unreadable-field
// excerpts — an admitted row whose excerpt field denies still returns the hit,
// just without the excerpt).
export interface SearchResultHit<THit> extends SearchResultStamp {
  readonly key: string;
  readonly rank: SearchRank;
  readonly hit: THit;
  readonly excerpt?: string;
}

// The closed error vocabulary of a failed response. `denied` = the search (or
// its scope) was denied; `policy-error` = a policy body threw (S5/A2 fail
// closed — never a 500); `not-found` = the plugin/resource does not exist;
// `error` = the plugin search itself failed (isolated, per S4/A1).
export type SearchResponseError = 'denied' | 'policy-error' | 'not-found' | 'error';

// The platform search response. `ok` is true only for a completed, authorized,
// uncancelled, in-time search. `hits` are already admitted (per-result
// authorization ran) and tie-broken; `omitted` discloses how many candidates
// were dropped by authorization (deny → omit), so a caller can tell a bounded
// result from a filtered one.
export interface SearchResponse<THit> {
  readonly ok: boolean;
  readonly pluginId: string;
  readonly generation: number;
  readonly staleness: SearchStaleness;
  readonly hits: readonly SearchResultHit<THit>[];
  readonly omitted: number;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly error: SearchResponseError | null;
}

export interface SearchResponseBuild<THit> {
  readonly pluginId: string;
  readonly generation: number;
  readonly staleness: SearchStaleness;
  readonly hits?: readonly {
    readonly key: string;
    readonly rank: SearchRank;
    readonly hit: THit;
    readonly excerpt?: string;
  }[];
  readonly omitted?: number;
  readonly cancelled?: boolean;
  readonly timedOut?: boolean;
  readonly error?: SearchResponseError | null;
}

// Build a frozen search response, stamping every hit with the response's
// `{ pluginId, generation, staleness }`. `ok` is derived — a denied, cancelled,
// timed-out, or error response is never `ok`. This is the one place the
// response shape is assembled, so every search surface (HTTP handler, live
// delivery, library callers) returns an identical contract.
export function buildSearchResponse<THit>(input: SearchResponseBuild<THit>): SearchResponse<THit> {
  const hits = Object.freeze((input.hits ?? []).map((entry) => Object.freeze({
    pluginId: input.pluginId,
    generation: input.generation,
    staleness: input.staleness,
    key: entry.key,
    rank: entry.rank,
    hit: entry.hit,
    ...(entry.excerpt !== undefined ? { excerpt: entry.excerpt } : {}),
  })));
  const cancelled = input.cancelled ?? false;
  const timedOut = input.timedOut ?? false;
  const error = input.error ?? null;
  return Object.freeze({
    ok: error === null && !cancelled && !timedOut,
    pluginId: input.pluginId,
    generation: input.generation,
    staleness: input.staleness,
    hits,
    omitted: input.omitted ?? 0,
    cancelled,
    timedOut,
    error,
  });
}
