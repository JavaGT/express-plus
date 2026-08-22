// Bootstrap retry diagnostics (Scope issue JavaGT/scope#815).
//
// The T720 harness proved a naive client that bootstraps with fresh nonces
// exhausts MAX_LEASES_PER_STREAM=16 per stream; ensureLease then refuses (only
// expired leases evict) and bootstrap degraded to a bare { kind: 'retry' }
// forever — indistinguishable from transient cursor churn until the 24h TTL.
//
// These tests pin the fix: every bootstrap-path retry carries a machine-
// readable additive `reason`, and lease exhaustion surfaces as
// 'lease-budget-exhausted' specifically, while healthy paths stay byte-for-
// byte unchanged (no reason field on success, bare retry preserved where no
// lease was ever sought).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, annotatedTextCreateAction,
  deny, entity, everyone, grant, read, ref, scope, subscribe, write,
} from '../build/index.mjs';
import { executeDDL, executeFrameworkDDL } from '../build/internal.mjs';
import {
  AUTHORING_STREAM_LIMITS, countLiveLeases, ensureLease, ensureStream, hashClientNonce,
} from '../build/annotated-text-authoring-stream.mjs';

const user = { type: 'user', id: 'u1', attributes: {} };
const NONCE = 'x'.repeat(43);
const nonceAt = (index) => `${String(index).padStart(2, '0')}${'y'.repeat(41)}`;

function foldDocEntity(name = 'RetryReasonDoc') {
  return entity(name, {
    project: ref('Project'), owner: ref('User', { role: 'owner' }),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')] }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
}

async function startApp(t, { authorization } = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1', 'u1'); INSERT INTO User VALUES ('u1')");
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('not owner'))],
  });
  const Document = foldDocEntity();
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document], authorization });
  app.attachLiveDelivery({ principalOf: () => user, authorization });
  app.listen(0, { principalOf: () => user });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const create = annotatedTextCreateAction(Document, Document.body, { id: 'd1', projectId: 'p1', ownerId: 'u1' });
  const created = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'create-doc', type: create.type, payload: create.payload, scope: 'Project:p1', clientId: 'tab-a' }),
  });
  assert.equal(created.status, 200);
  return { origin, db };
}

function bootstrapUrl(origin, nonce) {
  const params = new URLSearchParams({
    scope: 'Project:p1', mode: 'snapshot',
    entity: 'RetryReasonDoc', field: 'body', documentId: 'd1',
    ...(nonce ? { authoringClient: nonce } : {}),
  });
  return `${origin}/live-delivery/bootstrap?${params}`;
}

test('unit: countLiveLeases agrees with the ensureLease refusal at the cap', () => {
  const prefix = 'CountLeases_body';
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ${prefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_checkpoint (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, checkpoint_id TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${prefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
  `);
  const fixture = { documentId: 'doc-count', principalType: 'user', principalId: 'u-count' };
  const stream = ensureStream({ db, prefix, ...fixture });

  for (let index = 0; index < AUTHORING_STREAM_LIMITS.maxLeasesPerStream; index += 1) {
    const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(`count:${index}`) });
    assert.notEqual(lease, null, 'fill phase must succeed below the cap');
  }
  assert.equal(countLiveLeases(db, prefix, stream.id), AUTHORING_STREAM_LIMITS.maxLeasesPerStream);

  // The exact T720 wedge: a fresh nonce at cap is refused with nothing expired
  // to evict, and the live-lease count confirms the refusal cause.
  assert.equal(ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('count:stranger') }), null);
  assert.equal(countLiveLeases(db, prefix, stream.id), AUTHORING_STREAM_LIMITS.maxLeasesPerStream);
  db.close();
});

test('healthy bootstrap keeps its shape: authoring envelope present, no reason field', async (t) => {
  const { origin } = await startApp(t);
  const body = await fetch(bootstrapUrl(origin, NONCE)).then((response) => response.json());
  assert.equal(body.kind, 'snapshot');
  assert.equal(typeof body.authoring?.acknowledgementFence, 'number');
  assert.equal(body.authoring.stream.length > 0, true);
  assert.equal(Object.hasOwn(body, 'reason'), false, 'success results never carry a retry diagnostic');
});

test('re-bootstrapping the same nonce reuses the lease and stays healthy', async (t) => {
  const { origin } = await startApp(t);
  const first = await fetch(bootstrapUrl(origin, NONCE)).then((response) => response.json());
  const second = await fetch(bootstrapUrl(origin, NONCE)).then((response) => response.json());
  assert.equal(first.kind, 'snapshot');
  assert.equal(second.kind, 'snapshot');
  assert.equal(second.authoring.stream, first.authoring.stream, 'the stream is stable per (document, principal)');
  assert.notEqual(second.authoring.snapshot, undefined);
});

test('fresh-nonce bootstrap past the live-lease cap reports lease-budget-exhausted (#815)', async (t) => {
  const { origin } = await startApp(t);
  // Fill the stream's budget: each fresh nonce mints one live lease, exactly
  // the naive-client behavior the T720 harness exposed.
  for (let index = 0; index < AUTHORING_STREAM_LIMITS.maxLeasesPerStream; index += 1) {
    const body = await fetch(bootstrapUrl(origin, nonceAt(index))).then((response) => response.json());
    assert.equal(body.kind, 'snapshot', `fill bootstrap ${index} must succeed`);
  }
  const wedged = await fetch(bootstrapUrl(origin, nonceAt(99))).then((response) => response.json());
  assert.deepEqual(wedged, { kind: 'retry', reason: 'lease-budget-exhausted' });
  // The distinguishing property the old bare retry could never express: the
  // SAME response shape recurs deterministically instead of churning.
  const again = await fetch(bootstrapUrl(origin, 'zz' + 'y'.repeat(41))).then((response) => response.json());
  assert.deepEqual(again, { kind: 'retry', reason: 'lease-budget-exhausted' });
});

test('a committed change mid-projection surfaces cursor-moved, deterministically', async (t) => {
  // The injected authorization adapter advances the scope cursor while the
  // projection-time field-read admission awaits — the same interleaving a
  // concurrent commit produces — so the post-projection fence check fails with
  // the cursor responsible, not the lease. The FIRST body-read happens in the
  // pre-projection row authorization (before `before` is captured); the bump
  // must fire on the SECOND, inside projection.
  let bumped = false;
  let bodyReads = 0;
  const decision = () => ({
    admitted: true, operation: 'read', resourceCategory: 'entity', resourceId: null, reasonCode: null, capabilities: [], trace: null,
  });
  let sharedDb;
  const authorization = {
    admit: async (input) => {
      if (input.verb === 'read' && input.fieldName === 'body') {
        bodyReads += 1;
        if (!bumped && sharedDb && bodyReads === 2) {
          bumped = true;
          sharedDb.prepare('UPDATE _Cursor SET lastSeq = lastSeq + 1 WHERE scope = ?').run('Project:p1');
        }
      }
      return decision();
    },
  };
  const { origin, db } = await startApp(t, { authorization });
  sharedDb = db;
  const before = Number(db.prepare("SELECT lastSeq FROM _Cursor WHERE scope = 'Project:p1'").get()?.lastSeq ?? 0);
  const body = await fetch(bootstrapUrl(origin, NONCE)).then((response) => response.json());
  assert.deepEqual(body, { kind: 'retry', reason: 'cursor-moved' });
  assert.equal(Number(db.prepare("SELECT lastSeq FROM _Cursor WHERE scope = 'Project:p1'").get()?.lastSeq ?? 0), before + 1, 'the adapter hook moved the cursor');
});

test('nonce-less document bootstrap preserves the historical bare retry (additive only)', async (t) => {
  const { origin } = await startApp(t);
  const body = await fetch(bootstrapUrl(origin, null)).then((response) => response.json());
  // No lease was sought, so no exhaustion diagnosis applies: the response must
  // stay byte-identical to the pre-#815 behavior.
  assert.deepEqual(body, { kind: 'retry' });
});
