import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  readCommittedCursor,
  readCommittedEventsSince,
} from '../src/server.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';

test('server log reads expose committed events rather than storage rows', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'Project:project-1',
    1,
    'Project.renamed',
    JSON.stringify({ name: 'Field notes' }),
    'action-1',
    '2026-07-13T00:00:00.000Z',
  );
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)')
    .run('Project:project-1', 1);

  assert.equal(readCommittedCursor(db, 'Project:project-1'), 1);
  assert.deepEqual(
    readCommittedEventsSince(db, 'Project:project-1', 0),
    [{
      type: 'Project.renamed',
      scope: 'Project:project-1',
      seq: 1,
      actionId: 'action-1',
      committedAt: '2026-07-13T00:00:00.000Z',
      data: { name: 'Field notes' },
    }],
  );

  db.close();
});
