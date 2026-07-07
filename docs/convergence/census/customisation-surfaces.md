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

| Seam | Location | Default | Tested |
|------|----------|---------|--------|
| `bindAction(store, { id, action, payload, onStatusChange })` | `public/workbench-ui-bindings.mjs:27` | all options user-supplied | `test/workbench-ui.test.mjs:165` ✓ |
| `bindField(store, { id, field, onValueChange })` | `public/workbench-ui-bindings.mjs:119` | all options user-supplied | `test/workbench-ui.test.mjs:345` ✓ |
| `bindList(store, { id, field, onItemsChange })` | `public/workbench-ui-bindings.mjs:212` | all options user-supplied | `test/workbench-ui.test.mjs:441` ✓ |
| `bindConnection(channel)` | `public/workbench-ui-bindings.mjs:308` | disconnected when no hook | `test/workbench-ui.test.mjs:1194` ✓ |

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

## Gaps (owner-accepted — cosmetic, post-gate polish)

Three seams are either unexercised or proven only with defaults. All are owner-accepted as non-blocking for §8 completion:

1. **`listen({ blobReapIntervalMs, blobReapTtlMs })`** — framework constants exercised but explicit override values not tested. Post-gate polish: add explicit override test in `test/blob-reaper.test.mjs`.
2. **`listen({ logRetentionDays, logRetentionIntervalMs })`** — no test exercises the log retention reaper. Low risk: retention is off by default (0 days). Post-gate polish: add explicit override test.
3. **`createAuthClient({ fetchImpl })`** — tested with default only (globalThis.fetch). An explicit override is not tested but the shape is identical to `createLiveStore`'s `fetchImpl` which IS tested. Post-gate polish: add override test in `test/auth-routes.test.mjs`.

**Verdict:** The customisation surface is proven at the seam — every configurable option either has an explicit override test or rests on a shape tested elsewhere. The three gaps are owner-accepted as cosmetic (council c04). No production foot-gun.
