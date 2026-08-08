# Customisation sweep — override seams census

Generated: 2026-07-07. Gate: `node --test` 1612/1612/0.

Every layer ships sensible defaults. Every override seam is tested. This census
records each seam's default, what can be overridden, and where the override is
proven in the test suite.

---

## Auth layer

| Seam | Location | Default | Tested |
|------|----------|---------|--------|
| `rpConfig` — WebAuthn RP name/id/origin | `src/passkey.mjs:35` | `{ name:'workbench', id:'localhost', origin:'http://localhost:3000' }` | `test/passkey.test.mjs:405` ✓ |
| `authRoutes({ secure })` — cookie Secure flag | `src/auth-routes.mjs:48` | `config.env === 'production'` | `test/session.test.mjs:80` ✓ |
| `createChallengeStore(ttlMs)` | `src/passkey.mjs:59` | 5 minutes | `test/passkey.test.mjs:72` ✓ |
| `generateChallenge(length)` | `src/passkey.mjs:48` | 32 bytes | `test/passkey.test.mjs:62` ✓ |
| `emailSeam({ transport })` | `src/email-seam.mjs` | `noopTransport` | `test/totp.test.mjs` ✓ |

## Persistence layer

| Seam | Location | Default | Tested |
|------|----------|---------|--------|
| `workbench({ db })` — string/path/handle/driver | `src/app.mjs:326` | required (fail-closed) | `test/db-string-option.test.mjs` ✓ |
| `workbench({ blobs })` — blob store | `src/app.mjs:392` | `.blobs/` in cwd | `test/fs-blobs.test.mjs:229` ✓ |
| `resolveConfig(options)` — port, env, viewsDir, sessionDuration | `src/config.mjs:23` | port=3000, env=development, 7d session | `test/app-config.test.mjs` ✓ |
| `wrapDriver(db)` — custom driver | `src/driver.mjs:101` | SQLite fallback | `test/driver.test.mjs` ✓ |
| `workbench({ migrations })` | `src/app.mjs:422` | `[]` (none) | `test/migrations.test.mjs:114` ✓ |
| `workbench({ requireEnv })` | `src/app.mjs:327` | `[]` (none) | `test/ops-defaults.test.mjs:66` ✓ |

## Job queue layer

| Seam | Location | Default | Tested |
|------|----------|---------|--------|
| `createJobQueue({ sharedSecret, leaseMs, ... })` — 9 options | `src/job-queue.mjs:56` | leaseMs=30s, heartbeatGraceMs=90s, reapIntervalMs=15s, maxAttempts=5, backoffMs=5s, pollIntervalMs=1s | `test/job-queue.test.mjs` ✓ |
| `workbench({ jobs })` — queue passthrough | `src/app.mjs:412` | absent → no queue | `test/durable-effects.test.mjs:123` ✓ |
| `queue.work(kind, fn, { pollIntervalMs })` — per-worker poll | `src/job-queue.mjs:293` | inherits from createJobQueue | `test/job-worker.test.mjs:39` ✓ |

## Client engine layer

| Seam | Location | Default | Tested |
|------|----------|---------|--------|
| `LiveChannel(baseUrl, { maxBackoff, backoffBase })` | `public/workbench-client.mjs:31` | maxBackoff=5000, backoffBase=200 | `test/live-channel.test.mjs:160` ✓ |
| `createLiveStore({ baseUrl, name, path, channel, fetchImpl })` | `public/workbench-client.mjs:890` | channel=LiveChannel, fetchImpl=globalThis.fetch | `test/live-store.test.mjs` ✓ (channel fake); convergence integration ✓ (fetchImpl) |
| `createAuthClient({ baseUrl, fetchImpl })` | `public/workbench-client.mjs:1216` | fetchImpl=globalThis.fetch | `test/auth-routes.test.mjs:173` ✓ (default only) |

## UI kit layer

> **Deleted 2026-08-09** (issues #43/#44): the Svelte UI kit
> (`public/workbench-ui*.mjs`, `public/*.svelte`, and its test harness
> `test/workbench-ui.test.mjs`) had zero production consumers and was removed.
> The bindings/status seam described below no longer exists.

## Ops / listen layer

| Seam | Location | Default | Tested |
|------|----------|---------|--------|
| `listen(port, { principalOf })` | `src/serve.mjs:392` | session-based hydration | `test/session.test.mjs:131` ✓ |
| `listen(port, { rateLimit })` | `src/serve.mjs:409` | null (off) | `test/rate-limit-http.test.mjs` ✓ |
| `listen(port, { csp })` | `src/serve.mjs:410` | null (off) | `test/ops-defaults.test.mjs:84` ✓ |
| `listen(port, { hsts })` | `src/serve.mjs:410` | null (off) | `test/ops-defaults.test.mjs:119` ✓ |
| `listen(port, { cors })` | `src/serve.mjs:410` | null (off) | `test/ops-defaults.test.mjs:154` ✓ |
| `listen(port, { requestLog })` | `src/serve.mjs:410` | false | `test/ops-defaults.test.mjs:226` ✓ |
| `onShutdown(name, fn, { timeoutMs })` | `src/lifecycle.mjs:49` | timeoutMs=5000 | `test/ops-defaults.test.mjs:250` ✓ |

## Log layer

| Seam | Location | Default | Tested |
|------|----------|---------|--------|
| `createLog({ level, channels, format, output })` | `src/log.mjs:37` | level=info, format=json, output=stderr | `test/log.test.mjs` ✓ |
| `workbench({ log })` — log options passthrough | `src/app.mjs:364` | createLog defaults | `test/projected-async.test.mjs:315` ✓ |

---

## Closed gaps

`createAuthClient({ fetchImpl })` is explicitly exercised by the logout test in
`test/auth-routes.test.mjs`; the earlier census entry saying otherwise was stale.

The runtime maintenance overrides now belong to `workbench({ ... })`, because
they govern the whole application rather than one HTTP listener. Explicit blob
TTL and log-retention behavior is covered by `test/blob-reaper.test.mjs` and
`test/log-retention.test.mjs`.

**Verdict:** The customisation surface is proven at the seam — every configurable option has an explicit override test. No open gap remains.
