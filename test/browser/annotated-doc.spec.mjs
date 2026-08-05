import { expect, test } from '@playwright/test';
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
