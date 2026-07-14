// Pin the taxonomy of post-commit consumer kind contracts (kernel.mjs's
// POST_COMMIT_CONSUMER_KINDS). Three recovery contracts:
//   durable-projection-consumer, live-delivery-consumer, best-effort-external-consumer.
// Also pins that email is honestly undurable today (no cursor, no replay).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import workbench, { text, ref, blob, scope, grant, read, write, subscribe } from '../src/index.mjs';
import { entity, POST_COMMIT_CONSUMER_KINDS } from '../src/internal.mjs';
import { emailSeam } from '../src/email-seam.mjs';

// ---- Helpers ----

function photoNote() {
  return entity('Note', {
    body: text(),
    photo: blob(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

function durableSrc() {
  return entity('DurableSrc', {
    title: text(),
    grant: () => grant(read, write, subscribe),
    effects: (Src) => [
      [Src.created, {
        durable: 'send-title',
        with: ({ delta, origin }) => ({ title: delta.title, sourceId: origin.id }),
      }],
    ],
  });
}

// ---- Tests ----

test('postCommitConsumerDescriptors: every kind is a known value, expected consumers present', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = mkdtempSync(path.join(tmpdir(), 'wb-consdesc-'));
  const app = workbench({
    db,
    entities: [photoNote(), durableSrc()],
    blobs: { root },
    jobs: { sharedSecret: 'consumer-desc-secret', now: () => 1 },
  });
  app.mount('/notes', app.entity('Note'));
  app.mount('/durable-srcs', app.entity('DurableSrc'));
  emailSeam({ transport: async () => {} }).install(app);
  app.listen(0);
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  await app.ready;

  const descriptors = app.postCommitConsumerDescriptors;
  assert.ok(Array.isArray(descriptors), 'postCommitConsumerDescriptors should be an array');

  // Every kind must be a known POST_COMMIT_CONSUMER_KINDS value.
  for (const d of descriptors) {
    assert.ok(
      POST_COMMIT_CONSUMER_KINDS.includes(d.kind),
      `descriptor '${d.name}' has unknown kind '${d.kind}'`,
    );
  }

  const byName = Object.fromEntries(descriptors.map((d) => [d.name, d]));

  // blob.finalize — engaged because blobs configured + entity has a blob field.
  assert.ok(byName['blob.finalize'], 'blob.finalize descriptor should be present');
  assert.equal(byName['blob.finalize'].kind, 'durable-projection-consumer');

  // email — engaged because emailSeam.install() was called before listen().
  assert.ok(byName.email, 'email descriptor should be present');
  assert.equal(byName.email.kind, 'best-effort-external-consumer');

  // live — engaged because listen() creates app.live before buildKernel runs.
  assert.ok(byName.live, 'live descriptor should be present');
  assert.equal(byName.live.kind, 'live-delivery-consumer');

  // projected.async — consumer function is always created (truthy), so always present.
  assert.ok(byName['projected.async'], 'projected.async descriptor should be present');
  assert.equal(byName['projected.async'].kind, 'durable-projection-consumer');

  // effect.durable — engaged because durableSrc has a durable effect + jobs configured.
  assert.ok(byName['effect.durable'], 'effect.durable descriptor should be present');
  assert.equal(byName['effect.durable'].kind, 'durable-projection-consumer');
});

test('engagedPostCommitConsumerDescriptors does not branch on kind field', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const kernelPath = path.join(__dirname, '..', 'src', 'kernel.mjs');
  const source = readFileSync(kernelPath, 'utf8');

  // Extract the function body via a balanced-brace scan starting at the
  // function keyword, so we are not sensitive to line-count changes.
  const fnStart = source.indexOf('function engagedPostCommitConsumerDescriptors');
  assert.ok(fnStart !== -1, 'function engagedPostCommitConsumerDescriptors not found in kernel.mjs');

  const openBrace = source.indexOf('{', fnStart);
  assert.ok(openBrace !== -1, 'opening brace not found');

  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { closeBrace = i; break; }
    }
  }
  assert.ok(closeBrace !== -1, 'closing brace not found');

  const fnBody = source.substring(openBrace, closeBrace + 1);

  // Narrow, honestly-scoped check: the function that assembles the descriptor
  // array must not contain an if/switch branching on a descriptor's kind field.
  // This matches the doc comment above it which says recovery mechanics live in
  // each consumer's own module, not here. The check is intentionally narrow —
  // it does not claim there is no branching on kind anywhere in kernel.mjs.
  assert.ok(
    !fnBody.includes('kind ==='),
    'engagedPostCommitConsumerDescriptors should not contain kind ===',
  );
  assert.ok(
    !fnBody.includes('kind =='),
    'engagedPostCommitConsumerDescriptors should not contain kind ==',
  );

  // Also check for a switch statement referencing kind within the function body.
  const switchMatch = fnBody.match(/\bswitch\s*\(/);
  if (switchMatch) {
    const idx = switchMatch.index;
    const afterSwitch = fnBody.substring(idx, idx + 80);
    assert.ok(
      !afterSwitch.includes('kind'),
      'engagedPostCommitConsumerDescriptors should not contain a switch on kind',
    );
  }
});

test('email consumer is honestly undurable — transport errors swallowed, no cursor row', async (t) => {
  const db = new DatabaseSync(':memory:');
  let transportCalled = false;

  const seam = emailSeam({
    transport: async (_msg) => {
      transportCalled = true;
      throw new Error('smtp down');
    },
  });

  const app = workbench({ db });
  const Minimal = entity('Minimal', {
    title: text(),
    grant: () => grant(read, write, subscribe),
  });
  app.mount('/minimal', Minimal);
  seam.install(app);
  app.listen(0);
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.ready;

  const emailDesc = app.postCommitConsumerDescriptors.find((d) => d.name === 'email');
  assert.ok(emailDesc, 'email descriptor should be present');

  // (a) The try/catch in email-seam.mjs swallows transport errors — calling the
  // consumer with a throwing transport must not propagate the throw.
  await emailDesc.consumer(
    [{ type: 'email.send', data: { to: 'a@b.c', subject: 's', body: 'body text' } }],
    { db },
  );
  assert.ok(transportCalled, 'transport should have been called');

  // (b) There is no _ConsumerCursor row for consumer = 'email'. The email
  // consumer never calls upsertConsumerCursor — structural proof that a
  // crash between COMMIT and this consumer running silently drops the work
  // with no replay.
  const cursorCount = db.prepare(
    'SELECT COUNT(*) AS n FROM _ConsumerCursor WHERE consumer = ?',
  ).get('email').n;
  assert.equal(cursorCount, 0, 'email consumer must not write a _ConsumerCursor row');
});
