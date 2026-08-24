# Changelog

Notable public-surface changes per release. Each release entry keys its
semantic version to the full 40-hex commit SHA it was tagged at; the released
version must always agree with `package.json`. Consumers pin the SHA, never
the version or a tag.

Changelog format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
(`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Unreleased`).
Add the next entry as part of every public-surface change and fold the update
into the existing push/pin ritual.

## [Unreleased]

Changes since `v0.1.3` (`3546e35da0179300648ad1bdc8da149ee65690ec`). Version
and tag are assigned at the next release.

### Added

- Static serving policy options: `app.static(prefix, dir, options?)` and
  `serveStatic(dir, options)` now accept `cacheControl` (exact-path > path-prefix >
  extension policies) and `precompressed` (serve `.br`/`.gz` siblings when the client's
  Accept-Encoding admits them; identity unless explicitly excluded; typed
  `not-acceptable` failure → 406 only when nothing is acceptable; every 200/406 carries a
  case-insensitively merged `Vary`). Public declarations updated in both `index.d.ts` and
  `src/server.d.ts`; compile-time probes in `type-test/public-api.ts`.
- `not-acceptable` failure category mapping to HTTP 406 in `statusForFailure`.

### Added

- Blob stream reads for large media: `readBlobStream`,
  `ByteStore.readPendingStream`, `lifecycle.readClaimedStream`
  (`50def23a52c6d28d936c55a94f4a7a629436dd3a`).
- Blob stream writes end-to-end: `ByteStore.writePendingStream`; the stager
  routes iterables directly (`c3226643a061013517457306e0c81c23417e67f6`),
  hardened by review fixes — reverted LiveRetryReason sweep-in, completed
  `PendingBlobLifecycle` declaration, `BlobTooLargeError.received`
  (`abd7c711a2571e3f3da14146ac337ef0330053e8`).
- Typed snapshot grammar and `SnapshotValue` inference exposed in the public
  surface (`ef74396df4e79abe4e11c33ddc313f0c423dd030`).

### Fixed

- Annotated-text continuous editing: replaced the linear anchor walk and
  double-serialization frontier equality in src and the hand-maintained
  browser bundle, validated caller-supplied basis frontiers in
  `resolveOffsetToEndpoint`, backed by a deterministic differential suite
  (`ce1590a54b2232fcae305b0672b4f120d5a8bf7a`).

## [0.1.3] — 2026-08-17 — `3546e35da0179300648ad1bdc8da149ee65690ec`

Released at the Scope-pinned commit; aligns the `package.json` version field,
the `v0.1.3` tag, and the schema ledger `suppliedBy`. Carries the platform
wave accumulated since `v0.1.2`.

### Added

- Schema: namespaced host migration ledger — `(namespace, version)` identity,
  checksums, reserved namespaces, cross-namespace dependencies; exact schema
  validator with drift detection and entity trigger policy; pre-touch
  declaration validation; resumable maintenance resources and lifecycle
  preparation.
- Search plugin system: published plugin contract, durable FTS5 plugin,
  model-space vector search plugin, staleness/invalidation bridge, reconcile
  and shadow rebuild engine, authorization and response contract.
- Blobs: compiled blob-reference census replacing runtime `blobColumns`
  scans; authorized claim-only pending reads with generic denial and
  streaming; generation replacement, named retention, durable cleanup, and
  low-disk guard; backup/recovery/recycle seams over census + byte store.
- Live: collection subscriptions through live transport, atomic operations,
  revision-tiered delivery, state/state-invalidate envelope kinds with
  transport parity, and the no-history mutation lane wired into the
  application kernel with minimized idempotency receipts.
- Census-authorized owned index capability.

## [0.1.2] — 2026-07-23 — `75f19a459acb72c521c91e3db5de2b0e37b97354`

### Fixed

- Auth: enforce session expiry at admission and declare the session expiry
  options.
- Auth: reject malformed session timestamps.

## [0.1.1] — 2026-07-23 — `16251982ce8d7eb3ba62b297dc81d4d74f102904`

### Changed

- Hardened the private Git artifact: stripped agent-memory files and database
  artifacts from the packed package and tightened write-queue behavior.

## [0.1.0] — 2026-07-23 — `fda99ba9ba18c5d59166077b2610b6e7db9e0ae8`

### Added

- Initial private release of the collaborative, persisted, realtime data
  framework: declared entities with authorization and reactions, REST routes,
  WebSocket live stream, event log, reducers, optimistic UI placeholders, gap
  recovery, and client sync. Zero runtime dependencies; Node 22+.
