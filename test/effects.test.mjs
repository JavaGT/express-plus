// Effects pipeline test — map field mutation fires declared effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { entity, text, ref, map, grant, read, write, subscribe, generateDDL } from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';

test('map add fires effects, creating target entity rows', () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);

  const Inbox = entity('Inbox', {
    fields: { recipient: text(), doc: text(), kind: text() },
    grant: () => grant(read, write, subscribe),
  });
  for (const sql of generateDDL(Inbox)) db.exec(sql);

  const collaborators = map(ref('User'), { role: ['viewer', 'editor'] });

  const Doc = entity('Doc', {
    fields: {
      title: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
      collaborators,
    },
    grant: () => grant(read, write, subscribe),
    effects: {
      [collaborators.onAdded]: {
        mutate: Inbox,
        with: ({ delta, entity }) => ({ recipient: delta.member, doc: String(entity.id), kind: 'invite' }),
      },
    },
  });

  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare('INSERT INTO Doc (id, title, owner) VALUES (?, ?, ?)').run(1, 'Test', 'u1');

  const row = Doc.getOrFail(1);
  assert.equal(typeof row.collaborators.add, 'function');

  row.collaborators.add('u2', 'viewer');

  const inboxes = db.prepare('SELECT * FROM Inbox').all();
  assert.equal(inboxes.length, 1, 'effect should create one Inbox row');
  assert.equal(inboxes[0].recipient, 'u2');
  assert.equal(inboxes[0].doc, '1');
  assert.equal(inboxes[0].kind, 'invite');
});
