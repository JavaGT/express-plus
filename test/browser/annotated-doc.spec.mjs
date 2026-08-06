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

test.afterEach(async ({ page }) => {
  await page.close();
});

async function createDocument(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.locator('#status')).toContainText('live', { timeout: 15000 });
  const editor = page.locator('#editor');
  await expect(editor).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect(editor.locator('[data-block-id]')).toHaveCount(1);
  await editor.click();
  await expect(editor).toBeFocused();
  await editor.locator('[data-block-id]').evaluate((block) => {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  return page.locator('.doc.active small').textContent();
}

async function openDocument(page, id) {
  await page.goto(origin);
  await page.locator('.doc', { hasText: id }).click();
  await expect(page.locator('#status')).toContainText('live', { timeout: 15000 });
}

async function createCommentedDocument(page, { text = '1234567890', from = 2, to = 4, color = '#fef08a' } = {}) {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially(text, { delay: 0 });
  await expect(editor).toHaveText(text);
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element, rangeOffsets) => {
    const block = element.querySelector('[data-block-id]');
    const node = block.firstChild;
    const range = document.createRange();
    range.setStart(node, rangeOffsets.from);
    range.setEnd(node, rangeOffsets.to);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { from, to });
  await page.getByRole('combobox', { name: 'Comment color' }).selectOption(color);
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  await expect(page.locator('#status')).toHaveText('comment marker added');
  const marked = editor.locator('[data-annotation-families~="comment"]');
  await expect(marked).toHaveText(text.slice(from, to));
  return { id, editor, marked };
}

async function placeCaret(target, offset) {
  await target.evaluate((element, caretOffset) => {
    const range = document.createRange();
    range.setStart(element.firstChild, caretOffset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, offset);
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

test('the live JSON state mirrors the rendered document', async ({ page }) => {
  await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('state', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  const state = page.getByLabel('Live JSON state');
  await expect(state).toContainText('"text": "state"');
  await expect(state).toContainText('"blocks"');
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

test('paced sequential input never reports a buffered-input conflict', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await editor.pressSequentially('1234567890', { delay: 35 });
  await expect(editor).toHaveText('1234567890');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => errors).not.toContainEqual(expect.stringContaining('changed before buffered input'));
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

test('adding a comment marker preserves the selected and following text', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  const text = 'before selected after';
  await editor.pressSequentially(text, { delay: 0 });
  await expect(editor).toHaveText(text);
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.firstElementChild.firstChild;
    const range = document.createRange();
    range.setStart(node, 7);
    range.setEnd(node, 15);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await page.getByRole('button', { name: 'Add comment marker' }).click();
  await expect(page.locator('#status')).toHaveText('comment marker added');
  await expect(editor).toHaveText(text);
  const marked = editor.locator('[data-annotation-families~="comment"]');
  await expect(marked).toHaveText('selected');
  await expect(marked).toHaveCSS('background-color', 'rgb(254, 240, 138)');
  const comment = page.locator('.annotation-card');
  await expect(comment).toContainText('selected');
  await comment.hover();
  await expect(marked).toHaveCSS('background-color', 'rgb(245, 158, 11)');
  await editor.evaluate((element) => {
    const node = element.lastElementChild.firstChild;
    const range = document.createRange();
    range.setStart(node, node.data.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('!', { delay: 0 });
  await expect(editor).toHaveText(`${text}!`);
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText(`${text}!`);
});

test('adding a comment marker restores editor focus and the selected range', async ({ page }) => {
  const { editor } = await createCommentedDocument(page, { text: '1234567890', from: 3, to: 5 });
  await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('45');
});

test('overlapping comment colors mix and persist after reload', async ({ page }) => {
  const { id, editor } = await createCommentedDocument(page, { from: 2, to: 6, color: '#fecaca' });
  await editor.evaluate((element) => {
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    let offset = 0;
    const pointAt = (target) => {
      for (const node of nodes) {
        const next = offset + node.data.length;
        if (target <= next) return [node, target - offset];
        offset = next;
      }
      throw new Error('selection offset is outside the editor');
    };
    const [startNode, startOffset] = pointAt(4);
    offset = 0;
    const [endNode, endOffset] = pointAt(8);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('combobox', { name: 'Comment color' }).selectOption('#bfdbfe');
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  await expect(page.locator('.annotation-card')).toHaveCount(2);
  const overlap = editor.locator('[data-annotation-ids]').filter({ hasText: '56' });
  await expect(overlap).toHaveAttribute('data-annotation-ids', / /);
  await expect(overlap).toHaveCSS('--annotation-color', 'rgb(223, 211, 228)');
  await expect(overlap).toHaveCSS('background-color', 'rgb(223, 211, 228)');
  await page.reload();
  await openDocument(page, id);
  await expect(page.locator('#editor').locator('[data-annotation-ids]').filter({ hasText: '56' })).toHaveCSS('background-color', 'rgb(223, 211, 228)');
});

test('a comment can be deleted from the annotation list and stays deleted after reload', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('before selected after', { delay: 0 });
  await expect(editor).toHaveText('before selected after');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.firstElementChild.firstChild;
    const range = document.createRange();
    range.setStart(node, 7);
    range.setEnd(node, 15);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete comment 1' }).click();
  await expect(page.locator('#status')).toHaveText('comment marker deleted');
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveCount(0);
  await page.reload();
  await openDocument(page, id);
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await expect(editor).toHaveText('before selected after');
});

test('typing at comment edges stays outside while typing inside stays highlighted', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('1234567890', { delay: 0 });
  await expect(editor).toHaveText('1234567890');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.firstElementChild.firstChild;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 4);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  const marked = editor.locator('[data-annotation-families~="comment"]');
  await expect(marked).toHaveText('34');

  await marked.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('L', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('12L34567890');
  await expect(marked).toHaveText('34');

  await marked.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, element.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('R', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('12L34R567890');
  await expect(marked).toHaveText('34');

  await marked.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('I', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(marked).toHaveText('3I4');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('12L3I4R567890');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('3I4');
});

test('typing outside a whole-document comment creates unannotated edge text', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('34', { delay: 0 });
  await expect(editor).toHaveText('34');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.firstElementChild.firstChild;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  const marked = editor.locator('[data-annotation-families~="comment"]');
  await expect(marked).toHaveText('34');

  await marked.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('L', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('L34');
  await expect(marked).toHaveText('34');

  await marked.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, element.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('R', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('L34R');
  await expect(marked).toHaveText('34');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('L34R');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('34');
});

test('backspacing at the start of a comment deletes preceding text without expanding the comment', async ({ page }) => {
  const { id, editor, marked } = await createCommentedDocument(page);
  await placeCaret(marked, 0);
  await editor.press('Backspace');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('134567890');
  await expect(marked).toHaveText('34');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('134567890');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('34');
});

test('backspacing inside a comment shrinks the comment range and persists', async ({ page }) => {
  const { id, editor, marked } = await createCommentedDocument(page);
  await placeCaret(marked, 1);
  await editor.press('Backspace');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('124567890');
  await expect(marked).toHaveText('4');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('124567890');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('4');
});

test('repeated backspace crosses comment edges without losing the editor selection', async ({ page }) => {
  const { editor } = await createCommentedDocument(page, { text: '1234567890', from: 3, to: 5 });
  await placeCaret(editor.locator('[data-block-id]').last(), 5);
  for (const expected of ['123456789', '12345678', '1234567', '123456', '12345', '1234', '123', '12', '1', '']) {
    await editor.press('Backspace');
    await expect(editor).toHaveAttribute('aria-busy', 'false');
    await expect(editor).toHaveText(expected);
    await expect(editor).toBeFocused();
  }
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await expect(page.locator('.annotation-card')).toContainText('Attached text is not visible.');
});

test('forward deleting at the end of a comment deletes following text without expanding the comment', async ({ page }) => {
  const { id, editor, marked } = await createCommentedDocument(page);
  await placeCaret(marked, 2);
  await editor.press('Delete');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('123467890');
  await expect(marked).toHaveText('34');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('123467890');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('34');
});

test('replacing across comment blocks fails closed without removing the comment card', async ({ page }) => {
  const { id, editor } = await createCommentedDocument(page, { text: 'before selected after', from: 7, to: 15 });
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('replacement', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#status')).toContainText('selection replacement is not yet supported atomically');
  await expect(editor).toHaveText('before selected after');
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('before selected after');
  await expect(page.locator('.annotation-card')).toHaveCount(1);
});

test('clicking a comment card selects the exact annotated text', async ({ page }) => {
  const { editor } = await createCommentedDocument(page, { text: 'before selected after', from: 7, to: 15 });
  await editor.evaluate((element) => {
    element.blur();
    window.getSelection()?.removeAllRanges();
  });
  await expect(editor).not.toBeFocused();
  await page.locator('.annotation-card p').click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('selected');
  await expect(editor).toBeFocused();
});

test('switching documents keeps commented text and comment cards isolated', async ({ page }) => {
  const first = await createCommentedDocument(page, { text: 'first selected', from: 6, to: 14 });
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.locator('#status')).toContainText('live');
  const secondId = await page.locator('.doc.active small').textContent();
  const secondEditor = page.locator('#editor');
  await expect(secondEditor).toHaveText('');
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await secondEditor.pressSequentially('second text', { delay: 0 });
  await expect(secondEditor).toHaveText('second text');
  await expect(secondEditor).toHaveAttribute('aria-busy', 'false');

  await openDocument(page, first.id);
  await expect(page.locator('#editor')).toHaveText('first selected');
  await expect(page.locator('.annotation-card')).toHaveCount(1);
  await expect(page.locator('.annotation-card')).toContainText('selected');

  await openDocument(page, secondId);
  await expect(page.locator('#editor')).toHaveText('second text');
  await expect(page.locator('.annotation-card')).toHaveCount(0);
});

test('replacing selected text is atomic and survives reload', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('Hello', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.firstElementChild.firstChild;
    const range = document.createRange();
    range.setStart(node, 1);
    range.setEnd(node, 4);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('i', { delay: 0 });
  await expect(editor).toHaveText('Hio');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('Hio');
});

test('adding a marker while text is buffered fails closed without a page error', async ({ page }) => {
  await createDocument(page);
  const editor = page.locator('#editor');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await editor.pressSequentially('buffered text', { delay: 0 });
  await expect(editor.locator('[data-block-id]')).toHaveCount(1);
  await editor.evaluate((element) => {
    const node = element.firstElementChild.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  await expect(page.locator('#status')).toHaveText('wait for the local text change to finish before adding a marker');
  expect(pageErrors).toEqual([]);
  await expect(editor).toHaveText('buffered text');
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

test('paced typing in a duplicated tab keeps both tabs live and survives reload', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const id = await createDocument(first);
  const popup = first.waitForEvent('popup');
  await first.evaluate(() => window.open(location.href));
  const second = await popup;
  await openDocument(second, id);

  const text = 'paced typing crosses drafts';
  const firstEditor = first.locator('#editor');
  const secondEditor = second.locator('#editor');
  await firstEditor.click();
  await firstEditor.pressSequentially(text, { delay: 125 });

  await expect(firstEditor).toHaveText(text);
  await expect(firstEditor).toHaveAttribute('aria-busy', 'false');
  await expect(secondEditor).toHaveText(text);
  await first.reload();
  await openDocument(first, id);
  await expect(firstEditor).toHaveText(text);
  await expect(secondEditor).toHaveText(text);
  await context.close();
});
