import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAnnotatedDocApp } from '../../projects/annotated-doc/server.mjs';

let app;
let origin;
let directory;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'workbench-annotated-doc-'));
  const created = createAnnotatedDocApp({ db: path.join(directory, 'demo.db') });
  app = created.app;
  app.listen(0, { principalOf: created.principalOf });
  await app.ready;
  app.db.prepare(`INSERT OR IGNORE INTO User (id, username) VALUES ('demo', 'demo')`).run();
  app.db.prepare(`INSERT OR IGNORE INTO Project (id, owner) VALUES ('p1', 'demo')`).run();
  origin = `http://127.0.0.1:${app.httpServer.address().port}`;
});

test.afterAll(async () => {
  app.httpServer.closeAllConnections?.();
  await app.shutdown();
  await rm(directory, { recursive: true, force: true });
});

async function createDocument(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.locator('#status')).toContainText('live');
  await page.locator('#editor').click();
  return page.locator('.doc.active small').textContent();
}

async function openDocument(page, id) {
  await page.goto(origin);
  await page.locator('.doc', { hasText: id }).click();
  await expect(page.locator('#status')).toContainText('live');
}

test('rapid typing and scalar-safe deletion survive reload', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('hello😀', { delay: 0 });
  await expect(editor).toHaveText('hello😀');
  await editor.press('Backspace');
  await expect(editor).toHaveText('hello');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await openDocument(page, id);
  await expect(page.locator('#editor')).toHaveText('hello');
});

test('rapid sequential input persists every character', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('1234567890', { delay: 0 });
  await expect(editor).toHaveText('1234567890');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await openDocument(page, id);
  await expect(page.locator('#editor')).toHaveText('1234567890');
});

test('Cmd+Backspace deletes to the start of the current line', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('one two three', { delay: 0 });
  await expect(editor).toHaveText('one two three');
  await editor.press('Meta+Backspace');
  await expect(editor).toHaveText('');
  await expect(page.locator('#status')).toContainText('live');
  await expect(page.locator('#status')).not.toContainText('offset is outside text bounds');
  await page.reload();
  await openDocument(page, id);
  await expect(page.locator('#editor')).toHaveText('');
});

test('operation errors are visible and logged to the browser console', async ({ page }) => {
  await createDocument(page);
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/workbench/actions', (route) => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, failure: { message: 'Doc.body.operation invalid annotated-text value: offset is outside text bounds' } }),
  }));
  await page.locator('#editor').pressSequentially('x', { delay: 0 });
  await expect(page.locator('#status')).toHaveText('Doc.body.operation invalid annotated-text value: offset is outside text bounds');
  await expect.poll(() => errors).toContainEqual(expect.stringContaining('offset is outside text bounds'));
});

test('repeated reloads retain one authoring lease', async ({ page }) => {
  const id = await createDocument(page);
  for (let reload = 0; reload < 17; reload += 1) {
    await page.reload();
    await openDocument(page, id);
  }
  await expect(page.locator('#status')).toContainText('live');
  const leases = app.db.prepare(`SELECT COUNT(*) AS count
    FROM Doc_body_authoring_lease AS lease
    JOIN Doc_body_authoring_stream AS stream ON stream.id = lease.stream_id
    WHERE stream.document_id = ?`).get(id);
  expect(leases.count).toBe(1);
});

test('an exhausted document surfaces an error and never blocks new documents', async ({ page, browser }) => {
  const anchorId = '00000000-0000-0000-0000-000000000000';
  const exhaustedId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  await page.goto(origin);
  const created = await page.evaluate(async ([anchor, exhausted]) => {
    const create = (id) => fetch('/docs', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'fixture', id }),
    }).then((response) => response.json());
    return [await create(anchor), await create(exhausted)];
  }, [anchorId, exhaustedId]);
  expect(created.every((result) => result.ok)).toBe(true);
  await page.reload();
  await page.locator('.doc', { hasText: exhaustedId }).click();
  await expect(page.locator('#status')).toContainText('live');

  const stream = app.db.prepare(`SELECT id FROM Doc_body_authoring_stream WHERE document_id = ?`).get(exhaustedId);
  const insertLease = app.db.prepare(`INSERT INTO Doc_body_authoring_lease (id, stream_id, client_nonce_hash, acknowledged_fence, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)`);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  for (let index = 0; index < 15; index += 1) {
    insertLease.run(`fixture-lease-${index}`, stream.id, createHash('sha256').update(`fixture-nonce-${index}`).digest('hex'), now, later);
  }
  expect(app.db.prepare(`SELECT COUNT(*) AS count FROM Doc_body_authoring_lease WHERE stream_id = ?`).get(stream.id).count).toBe(16);

  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto(origin);
  await expect(fresh.locator('#status')).toContainText('live', { timeout: 15000 });
  await fresh.locator('.doc', { hasText: exhaustedId }).click();
  await expect(fresh.locator('#status')).toContainText('try again', { timeout: 15000 });
  await fresh.getByRole('button', { name: 'New document' }).click();
  await expect(fresh.locator('#status')).toContainText('live', { timeout: 15000 });
  await context.close();
});

test('two pages converge through session ingest without repair writes', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const id = await createDocument(first);
  const second = await context.newPage();
  await openDocument(second, id);

  await first.locator('#editor').click();
  await first.locator('#editor').pressSequentially('A', { delay: 0 });
  await expect(first.locator('#editor')).toHaveText('A');
  await expect(second.locator('#editor')).toHaveText('A');
  await second.locator('#editor').click();
  await second.locator('#editor').pressSequentially('B', { delay: 0 });
  await expect(first.locator('#editor')).toHaveText('AB');
  await expect(second.locator('#editor')).toHaveText('AB');
  await context.close();
});

test('two pages type concurrently and converge on identical final text', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const id = await createDocument(first);
  const second = await context.newPage();
  await openDocument(second, id);

  const firstEditor = first.locator('#editor');
  const secondEditor = second.locator('#editor');
  await firstEditor.click();
  await secondEditor.click();
  const [firstTyped, secondTyped] = ['A', 'B'];
  await Promise.all([
    firstEditor.pressSequentially(firstTyped, { delay: 0 }),
    secondEditor.pressSequentially(secondTyped, { delay: 0 }),
  ]);

  await expect.poll(async () => {
    const firstText = (await firstEditor.textContent()) ?? '';
    const secondText = (await secondEditor.textContent()) ?? '';
    return firstText === secondText && [...firstText].sort().join('') === 'AB';
  }, { timeout: 15000 }).toBe(true);

  await first.reload();
  await openDocument(first, id);
  await expect(firstEditor).toHaveText(/^[AB]{2}$/);
  await expect(secondEditor).toHaveText(/^[AB]{2}$/);
  await context.close();
});
