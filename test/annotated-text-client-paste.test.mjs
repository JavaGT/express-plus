// Client `paste()` — annotation-aware paste dispatch.
// session.paste({ at, text, annotation: { family, fields } }) must:
//  1. project the pasted text optimistically (same as an insert);
//  2. dispatch ONE `annotation.paste` edit (never a plain text.insert, never
//     coalesced into a typing burst — the burst combiner would drop the
//     annotation sidecar);
//  3. fail closed on empty text / missing family without dispatching.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { annotatedText, annotation, entity, ref } from '../build/index.mjs';
import { importTextToFamily, textFamilyCheckpoint } from '../public/workbench-annotated-text-continuous.mjs';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';

const Document = entity('PasteClientDoc', {
  project: ref('Project'), owner: ref('User'),
  body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')] }),
});

function token(label) {
  return `${label}${'x'.repeat(43)}`.slice(0, 43);
}

function authoringEnvelope(cursor, family) {
  return {
    version: 1, stream: token('stream'), lease: token('lease'), snapshot: token(`snapshot${cursor}`),
    acknowledgementFence: cursor, positionFrames: [{ positionToken: token(`position${cursor}`) }],
    ...(family ? { family } : {}),
  };
}

function seedHelloWorld() {
  return importTextToFamily('d1', 'a'.repeat(32), 'hello world');
}

/** Recursively find the first object with kind === `wanted`. */
function findEditKind(value, wanted) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === wanted) return value;
  for (const entry of Object.values(value)) {
    const found = findEditKind(entry, wanted);
    if (found) return found;
  }
  return null;
}

/** Recursively find the first object with kind === 'annotation.paste'. */
function findPasteEdit(value) {
  return findEditKind(value, 'annotation.paste');
}

async function bootSession(options = {}) {
  void options;
  const baseFamily = seedHelloWorld();
  const sources = [];
  const posts = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${number}-${posts.length}`,
    fetchImpl: async (url, fetchOptions) => {
      if (fetchOptions?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
        posts.push(typeof fetchOptions.body === 'string' ? fetchOptions.body : JSON.stringify(fetchOptions.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world', ranges: [], annotations: [], orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  return { session, sources, posts };
}

test('paste projects text optimistically and dispatches one annotation.paste edit', async (t) => {
  const { session, posts } = await bootSession();
  t.after(() => session.close());

  const pending = session.paste({
    at: { offset: 6, affinity: 'right' },
    text: 'zz',
    annotation: { family: 'note', fields: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.document.text, 'hello zzworld');

  assert.equal(posts.length, 1);
  const edit = findPasteEdit(JSON.parse(posts[0]));
  assert.ok(edit, 'dispatched action carries an annotation.paste edit');
  assert.equal(edit.text, 'zz');
  assert.equal(edit.annotation.family, 'note');
  assert.deepEqual(edit.at.offset, 6);
  session.close();
  await pending;
});

test('paste never coalesces into an open typing burst', async (t) => {
  const { session, posts } = await bootSession();
  // Harden against mid-test assertion throws: pending ops reject at close.
  let typing = null;
  let pasting = null;
  t.after(async () => { session.close(); await Promise.allSettled([typing, pasting]); });

  // A mutationId-less insert opens a typing burst (no dispatch yet: the idle
  // window is 75ms by default).
  typing = session.insert({ at: { offset: 5, affinity: 'right' }, text: '!' });
  typing.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(posts.length, 0, 'burst holds the insert');

  // The paste must flush the burst instead of merging into it: the burst
  // combiner only carries { at, text } and would drop the annotation sidecar.
  pasting = session.paste({
    at: { offset: 6, affinity: 'right' },
    text: 'zz',
    annotation: { family: 'note', fields: {} },
  });
  pasting.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(posts.length, 1, 'paste flushed the burst into its own dispatch');
  const burstEdit = findEditKind(JSON.parse(posts[0]), 'text.insert');
  assert.ok(burstEdit, 'flushed burst dispatches as text.insert');
  assert.equal(burstEdit.text, '!', 'burst text is unextended by the paste');
});

test('paste fails closed on empty text or missing family without dispatching', async (t) => {
  const { session, posts } = await bootSession();
  t.after(() => session.close());

  const empty = await session.paste({ at: { offset: 6, affinity: 'right' }, text: '', annotation: { family: 'note' } });
  assert.equal(empty.ok, false);
  const noFamily = await session.paste({ at: { offset: 6, affinity: 'right' }, text: 'zz', annotation: {} });
  assert.equal(noFamily.ok, false);
  const noPosition = await session.paste({ at: { offset: -1, affinity: 'right' }, text: 'zz', annotation: { family: 'note' } });
  assert.equal(noPosition.ok, false);
  assert.equal(posts.length, 0, 'no dispatch for invalid paste input');
  assert.equal(session.document.text, 'hello world');
});
