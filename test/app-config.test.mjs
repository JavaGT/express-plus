// app-config.test.mjs — per-app config (T6). `workbench({ port, env, session,
// viewsDir })` resolves an `app.config` whose options override env fallbacks, so
// two apps in one process can carry different ports / envs / session durations
// without touching the process-wide singleton. `app.listen()` is portless and
// binds `app.config.port`. The per-app session duration installs a shallow
// Session copy whose schedule.remove trigger carries the app's delay, which
// buildKernel prefers over the framework singleton.

import { entity, text, ref, grant, read, write, subscribe, scope, Session } from '../build/index.mjs';
import { resolveConfig, config } from '../build/internal.mjs';
import workbench from '../build/internal.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A minimal owned entity (the note.mjs floor), used so an app has a mounted
// route to resolve during app.ready.
function makeNote() {
  return entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

// --- resolveConfig: options override env fallbacks, absent options match singleton ---

test('resolveConfig() with no args matches the frozen singleton', () => {
  assert.deepEqual(resolveConfig(), config, 'no-arg resolveConfig is the env-sourced defaults');
});

test('resolveConfig is frozen', () => {
  assert.ok(Object.isFrozen(resolveConfig({ port: 4000 })), 'a resolved config is frozen');
});

test('resolveConfig({ port }) overrides the env port; a non-integer falls back to 3000', () => {
  assert.equal(resolveConfig({ port: 4321 }).port, 4321, 'an explicit port wins');
  assert.equal(resolveConfig({ port: 'not-a-port' }).port, 3000, 'a bad port falls back');
  assert.equal(resolveConfig({ port: 0 }).port, 0, 'port 0 (ephemeral) is a valid port');
});

test('resolveConfig({ env }) overrides NODE_ENV', () => {
  assert.equal(resolveConfig({ env: 'production' }).env, 'production');
  assert.equal(resolveConfig({}).env, config.env, 'absent env matches the singleton');
});

test('resolveConfig({ viewsDir }) overrides VIEWS_DIR', () => {
  assert.equal(resolveConfig({ viewsDir: '/tmp/views' }).viewsDir, '/tmp/views');
  assert.equal(resolveConfig({}).viewsDir, config.viewsDir, 'absent viewsDir matches the singleton');
});

test('resolveConfig({ session: { durationMs } }) overrides the 7-day default', () => {
  assert.equal(resolveConfig({ session: { durationMs: 60_000 } }).sessionDurationMs, 60_000);
  assert.equal(resolveConfig({}).sessionDurationMs, 7 * 86_400_000, 'absent session matches the 7-day default');
});

// --- app.config: per-app, independent of the singleton and of other apps ---

test('workbench({ port }) sets app.config.port; two apps differ in one process', () => {
  const a = workbench({ db: ':memory:', port: 1111 });
  const b = workbench({ db: ':memory:', port: 2222 });
  assert.equal(a.config.port, 1111);
  assert.equal(b.config.port, 2222);
  assert.equal(config.port, resolveConfig().port, 'the singleton is untouched by app construction');
  assert.notEqual(a.config.port, b.config.port, 'two apps carry different ports');
  a.db.close();
  b.db.close();
});

test('app.config is frozen', () => {
  const app = workbench({ db: ':memory:' });
  assert.ok(Object.isFrozen(app.config), 'app.config is frozen');
  app.db.close();
});

test('workbench({ env, viewsDir, session }) threads through to app.config', () => {
  const app = workbench({ db: ':memory:', env: 'production', viewsDir: '/v', session: { durationMs: 1234 } });
  assert.equal(app.config.env, 'production');
  assert.equal(app.config.viewsDir, '/v');
  assert.equal(app.config.sessionDurationMs, 1234);
  app.db.close();
});

// --- per-app session duration configures the canonical bound Session ---

test('a non-default session duration records an app-local schedule override', () => {
  const app = workbench({ db: ':memory:', session: { durationMs: 60_000 } }).auth();
  assert.equal(app._sessionSchedule.remove.delay, 60_000);
  assert.notEqual(app._sessionSchedule.remove.delay, config.sessionDurationMs);
  app.db.close();
});

test('the per-app Session schedule preserves the compiled trigger shape', () => {
  const app = workbench({ db: ':memory:', session: { durationMs: 60_000 } }).auth();
  const orig = Session.schedule.remove;
  const copy = app._sessionSchedule.remove;
  // The compiled trigger stamps fieldName/whileSql/whileParams/sourceName; the
  // spread preserves every stamped prop and overrides only delay.
  assert.equal(copy.fieldName, orig.fieldName, 'fieldName preserved');
  assert.equal(copy.whileSql, orig.whileSql, 'whileSql preserved');
  assert.equal(copy.sourceName, orig.sourceName, 'sourceName preserved');
  assert.equal(copy.kind, orig.kind, 'kind preserved');
  assert.equal(copy.delay, 60_000, 'only delay is overridden');
  assert.ok(Object.isFrozen(copy), 'the override trigger is frozen');
  app.db.close();
});

test('a default session duration does not install an override', () => {
  const app = workbench({ db: ':memory:' }).auth();
  assert.equal(app._sessionSchedule, undefined);
  app.db.close();
});

test('buildKernel applies the override to the canonical app-bound Session', async () => {
  const app = workbench({ db: ':memory:', session: { durationMs: 90_000 } })
    .mount('/notes', makeNote())
    .auth()
    .listen(0);
  await app.ready;
  const entity = app.entities.get('Session');
  assert.equal(entity, app.entity(Session));
  assert.equal(entity.schedule.remove.delay, 90_000, 'the kernel registered the per-app copy');
  app.httpServer.close();
});

// --- portless listen() binds app.config.port ---

test('portless listen() binds app.config.port (ephemeral port 0)', async () => {
  const app = workbench({ db: ':memory:', port: 0 }).mount('/notes', makeNote()).listen();
  await app.ready;
  const bound = app.httpServer.address().port;
  assert.equal(app.port, 0, 'app.port reflects the configured port');
  assert.ok(bound > 0, 'the OS assigned an ephemeral port');
  app.httpServer.close();
});

test('an explicit listen(port) still wins over app.config.port', async () => {
  const app = workbench({ db: ':memory:', port: 0 }).mount('/notes', makeNote()).listen(0);
  await app.ready;
  assert.equal(app.port, 0, 'the explicit listen argument is used');
  assert.ok(app.httpServer.address().port > 0, 'a socket was bound');
  app.httpServer.close();
});

test('listen(callback) uses config.port — does not treat the function as a port', async () => {
  let fired = false;
  const app = workbench({ db: ':memory:', port: 0 })
    .mount('/notes', makeNote())
    .listen(() => { fired = true; });
  await app.ready;
  assert.equal(app.port, 0, 'callback is not used as the port argument');
  assert.equal(typeof app.port, 'number');
  assert.ok(app.httpServer.address().port > 0);
  // onListening may fire before or after ready depending on race — wait briefly
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired, true, 'callback runs as onListening');
  app.httpServer.close();
});

test('listen({ principalOf, onListening }) uses config.port, not the options object as port', async () => {
  let fired = false;
  const principal = { type: 'user', id: 'u1' };
  const app = workbench({ db: ':memory:', port: 0 })
    .mount('/notes', makeNote())
    .listen({
      principalOf: () => principal,
      onListening: () => { fired = true; },
    });
  await app.ready;
  assert.equal(app.port, 0);
  assert.equal(typeof app.port, 'number');
  assert.ok(app.httpServer.address().port > 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired, true);
  // Health is public — proves the socket is the configured bind
  const port = app.httpServer.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  app.httpServer.close();
});
