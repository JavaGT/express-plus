import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decideReplay, normalizeSeqSpan } from '../src/replay-decision.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('workbench-client embeds the same replay-decision body as src', () => {
  const src = readFileSync(join(root, 'src/replay-decision.mjs'), 'utf8');
  const client = readFileSync(join(root, 'public/workbench-client.mjs'), 'utf8');

  // Extract the pure function bodies from the source module (strip exports).
  const body = src
    .replace(/^\/\/.*$/gm, '')
    .replace(/export /g, '')
    .trim();
  // The client must contain the GENERATED block markers and the core predicates.
  assert.match(client, /BEGIN GENERATED from src\/replay-decision\.mjs/);
  assert.match(client, /END GENERATED from src\/replay-decision\.mjs/);
  assert.match(client, /function decideReplay\(cursor, seqOrSpan\)/);
  assert.match(client, /function normalizeSeqSpan\(seqOrSpan\)/);
  // Load-bearing predicates must match the source module verbatim.
  for (const fragment of [
    'if (hi < expected) return { kind: \'duplicate\' };',
    'if (lo > expected) return { kind: \'gap\' };',
    'return { kind: \'next\', cursor: hi };',
  ]) {
    assert.ok(src.includes(fragment), `src missing ${fragment}`);
    assert.ok(client.includes(fragment), `client missing ${fragment}`);
  }
  assert.ok(body.includes('normalizeSeqSpan'));
});

test('createClient is span-aware via decideReplay (shared core)', async () => {
  const { createClient, event } = await import('../src/pipeline.mjs');
  const e = event('Note.created', (s, ev) => ({ ...s, ...ev.data }));
  const client = createClient({ events: [e] });
  client.bootstrap('Note:1', { id: '1' }, 0);

  // Single-seq next
  assert.deepEqual(
    client.ingest({ type: 'Note.created', scope: 'Note:1', seq: 1, data: { title: 'a' } }),
    { applied: true },
  );
  assert.equal(client.cursor('Note:1'), 1);

  // Coalesced span next (P6e-4 forward-compat): covers expected=2, advances to hi
  assert.deepEqual(
    client.ingest({
      type: 'Note.created',
      scope: 'Note:1',
      seq: 4,
      seqSpan: [2, 4],
      data: { title: 'b' },
    }),
    { applied: true },
  );
  assert.equal(client.cursor('Note:1'), 4);

  // Duplicate (seq already covered by prior span)
  assert.deepEqual(
    client.ingest({ type: 'Note.created', scope: 'Note:1', seq: 3, data: {} }),
    { applied: false, duplicate: true },
  );

  // Gap
  assert.deepEqual(
    client.ingest({ type: 'Note.created', scope: 'Note:1', seq: 9, data: {} }),
    { applied: false, resync: true },
  );

  // decideReplay itself is the shared core
  assert.deepEqual(decideReplay(1, [2, 4]), { kind: 'next', cursor: 4 });
  assert.deepEqual(normalizeSeqSpan(7), [7, 7]);
});
