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
    const node = element.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
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

// Place the caret at a display offset inside the blockless editor (the single
// block span holds nested marker spans, so walk the block's text in order).
async function placeCaretAtDisplay(editor, displayOffset) {
  await editor.evaluate((element, targetOffset) => {
    const block = element.querySelector('[data-block-id]');
    let remaining = Math.max(0, Math.min(targetOffset, block.textContent.length));
    const walker = element.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = null;
    let nodeOffset = 0;
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (remaining <= current.data.length) {
        node = current;
        nodeOffset = remaining;
        break;
      }
      remaining -= current.data.length;
    }
    const range = document.createRange();
    range.setStart(node ?? block, nodeOffset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, displayOffset);
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
  await expect(state).toContainText('"ranges"');
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
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
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
    const block = element.querySelector('[data-block-id]');
    const walker = element.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let last = null;
    while (walker.nextNode()) last = walker.currentNode;
    const range = document.createRange();
    range.setStart(last, last.data.length);
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
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
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

test('typing after an end comment keeps the caret outside the comment', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('1234567890', { delay: 0 });
  await expect(editor).toHaveText('1234567890');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 8);
    range.setEnd(node, 10);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  await expect(page.locator('#status')).toHaveText('comment marker added');
  const marked = editor.locator('[data-annotation-families~="comment"]');
  await expect(marked).toHaveText('90');

  await marked.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, element.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await editor.pressSequentially('xy', { delay: 40 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('1234567890xy');
  await expect(marked).toHaveText('90');
  await expect.poll(() => page.evaluate(() => {
    const editorEl = document.getElementById('editor');
    const selection = window.getSelection();
    if (!selection?.anchorNode) return null;
    let span = selection.anchorNode.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode;
    while (span && span.parentElement !== editorEl) span = span.parentElement;
    return span ? { blockId: span.dataset.blockId, annotated: span.dataset.annotationFamilies?.includes('comment') === true, text: span.textContent } : null;
  })).toEqual(expect.objectContaining({ blockId: 'b', annotated: false, text: '1234567890xy' }));
  await expect.poll(() => errors).not.toContainEqual(expect.stringContaining('changed before buffered input'));
  const emptyAnnotated = await page.evaluate(() => {
    const state = JSON.parse(document.querySelector('#live-state pre')?.textContent ?? 'null');
    return (state?.blocks ?? []).filter((block) => block.kind === 'visible' && block.text === '' && (block.annotationIds?.length ?? 0) > 0);
  });
  expect(emptyAnnotated).toEqual([]);
});

test('boundary typing follows the blockless range affinity', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('1234567890', { delay: 0 });
  await expect(editor).toHaveText('1234567890');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
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

  // An insertion AT the range start joins the comment (start anchor leans
  // left); the range grows to include the inserted character.
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
  await expect(marked).toHaveText('L34');

  // An insertion AT the range end stays outside; the range does not grow.
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
  await expect(marked).toHaveText('L34');

  // An insertion strictly inside the range grows it.
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
  await expect(marked).toHaveText('LI34');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('12LI34R567890');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('LI34');
});

test('typing at the edges of a whole-document comment follows boundary affinity', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('34', { delay: 0 });
  await expect(editor).toHaveText('34');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Add comment marker' }).click();
  const marked = editor.locator('[data-annotation-families~="comment"]');
  await expect(marked).toHaveText('34');

  // The range starts at the document start: an insert at offset 0 joins it.
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
  await expect(marked).toHaveText('L34');

  // An insert at the range end stays outside.
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
  await expect(marked).toHaveText('L34');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('L34R');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('L34');
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
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const { editor } = await createCommentedDocument(page, { text: '1234567890', from: 3, to: 5 });
  await placeCaretAtDisplay(editor, 10);
  for (const expected of ['123456789', '12345678', '1234567', '123456', '12345', '1234', '123', '12', '1', '']) {
    await editor.press('Backspace');
    await expect(editor).toHaveAttribute('aria-busy', 'false');
    await expect(editor).toHaveText(expected);
    await expect(editor).toBeFocused();
  }
  await expect.poll(() => errors).not.toContainEqual(expect.stringContaining('cannot edit another block'));
  // Emptying annotated text drops the comment (empty: orphan). Fully cleared
  // docs keep exactly one empty editable block.
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await expect(editor.locator('[data-block-id]')).toHaveCount(1);
  const state = await page.evaluate(() => JSON.parse(document.querySelector('#live-state pre')?.textContent ?? 'null'));
  expect(state.text).toEqual('');
  expect(state.ranges ?? []).toEqual([]);
  expect(state.annotations ?? []).toEqual([]);
});

test('removing the final comment orphans it but retains one editable block', async ({ page }) => {
  const { id, editor } = await createCommentedDocument(page, { text: '1234567890', from: 3, to: 5 });
  await placeCaretAtDisplay(editor, 10);
  for (let index = 0; index < 10; index += 1) {
    await editor.press('Backspace');
    await expect(editor).toHaveAttribute('aria-busy', 'false');
  }
  // Text deletes emptied the comment range (orphan policy): the card is gone,
  // the annotation survives server-side as an orphan, and the doc keeps one
  // empty editable block.
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await expect(editor.locator('[data-block-id]')).toHaveCount(1);
  await expect(editor).toHaveText('');
  const state = app.db.prepare(`SELECT
    (SELECT COUNT(*) FROM Doc_body_state WHERE document_id = ?) AS state,
    (SELECT COUNT(*) FROM Doc_body_annotation WHERE document_id = ?) AS annotations,
    (SELECT COUNT(*) FROM Doc_body_annotation_orphan_state AS orphan JOIN Doc_body_annotation AS annotation ON annotation.id = orphan.annotation_id WHERE annotation.document_id = ?) AS orphans,
    (SELECT COUNT(*) FROM Doc_body_membership AS membership JOIN Doc_body_annotation AS annotation ON annotation.id = membership.annotation_id WHERE annotation.document_id = ?) AS memberships,
    (SELECT COUNT(*) FROM Doc_body_measurement WHERE document_id = ?) AS measurements`).get(id, id, id, id, id);
  expect(state).toEqual({ state: 1, annotations: 1, orphans: 1, memberships: 0, measurements: 0 });
  await page.reload();
  await openDocument(page, id);
  await expect(page.locator('#editor').locator('[data-block-id]')).toHaveCount(1);
  await page.locator('#editor').pressSequentially('again', { delay: 0 });
  await expect(page.locator('#editor')).toHaveText('again');
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

test('replacing the whole document drops the comment the replacement covers', async ({ page }) => {
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
  await expect(editor).toHaveText('replacement');
  // A covering replace empties the commented range (orphan policy): the card
  // disappears and the replacement text is unannotated.
  await expect(page.locator('.annotation-card')).toHaveCount(0);
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveCount(0);
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('replacement');
  await expect(page.locator('.annotation-card')).toHaveCount(0);
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
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
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
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
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

test('two pages converge on identical final text through sequential typing', async ({ browser }) => {
  // Concurrent same-position typing fails CLOSED in the blockless client: a
  // keystroke whose captured basis moved (a foreign insert landed first) is
  // rejected with "authoring basis is stale" rather than rebased (verified
  // empirically and locked by the http-session/receipt tests). The demo's
  // collaborative guarantee is delivery convergence, exercised here by typing
  // in each tab after the other's change has settled and propagated.
  const context = await browser.newContext();
  const first = await context.newPage();
  const id = await createDocument(first);
  const second = await context.newPage();
  await openDocument(second, id);

  const firstEditor = first.locator('#editor');
  const secondEditor = second.locator('#editor');
  await firstEditor.click();
  await firstEditor.pressSequentially('A', { delay: 0 });
  await expect(firstEditor).toHaveText('A');
  await expect(firstEditor).toHaveAttribute('aria-busy', 'false');
  await expect(secondEditor).toHaveText('A');

  await secondEditor.click();
  await secondEditor.pressSequentially('B', { delay: 0 });
  await expect(secondEditor).toHaveText('AB');
  await expect(secondEditor).toHaveAttribute('aria-busy', 'false');
  await expect(firstEditor).toHaveText('AB');

  await first.reload();
  await openDocument(first, id);
  await expect(firstEditor).toHaveText('AB');
  await expect(secondEditor).toHaveText('AB');
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

test('a confidential span shows the real text to the owner and a redacted placeholder to the reader', async ({ page, browser }) => {
  // Owner (demo) marks "secret" as confidential over a selection.
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('hello secret world', { delay: 0 });
  await expect(editor).toHaveText('hello secret world');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 12);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Mark confidential' }).click();
  await expect(page.locator('#status')).toHaveText('confidential span marked');
  // The protected target is projection-internal: no comment card is created for
  // a confidential span (only explicit comments render as cards).
  await expect(page.locator('.annotation-card')).toHaveCount(0);

  // Owner still sees the real text, styled as confidential (black bg, white text).
  await expect(editor).toHaveText('hello secret world');
  const ownerSensitive = editor.locator('[data-annotation-families~="sensitive"]');
  await expect(ownerSensitive).toHaveText('secret');
  await expect(ownerSensitive).toHaveCSS('background-color', 'rgb(17, 17, 17)');
  await expect(ownerSensitive).toHaveCSS('color', 'rgb(255, 255, 255)');

  // Reader opens the same document and sees the redacted placeholder. The view
  // is per-tab (sessionStorage), so set it via the toggle rather than a cookie.
  const context = await browser.newContext();
  await context.addInitScript(() => sessionStorage.setItem('annotated-doc-view-as', 'reader'));
  const readerPage = await context.newPage();
  await readerPage.goto(origin);
  await readerPage.locator('.doc', { hasText: id }).click();
  await expect(readerPage.locator('#status')).toContainText('live', { timeout: 15000 });
  const readerEditor = readerPage.locator('#editor');
  await expect(readerEditor).toHaveText('hello [restricted] world');
  await expect(readerEditor).not.toContainText('secret');
  // The redacted placeholder is styled black-on-white with its square brackets.
  const readerRestricted = readerEditor.locator('[data-restricted="true"]');
  await expect(readerRestricted).toHaveText('[restricted]');
  await expect(readerRestricted).toHaveCSS('background-color', 'rgb(17, 17, 17)');
  await expect(readerRestricted).toHaveCSS('color', 'rgb(255, 255, 255)');
  // A redacted recipient reads display offsets that do not map onto the wire
  // offsets the session authors; editing fails closed instead of submitting
  // mis-translated offsets (and never mutates the owner's document).
  const readerErrors = [];
  readerPage.on('console', (message) => {
    if (message.type() === 'error') readerErrors.push(message.text());
  });
  await readerEditor.click();
  await readerEditor.pressSequentially('X', { delay: 0 });
  await expect(readerEditor).toHaveText('hello [restricted] world');
  await expect.poll(() => readerErrors).toContainEqual(expect.stringContaining('redacted'));
  // The failed reader edit never submitted an action: the owner still sees the
  // original text after a fresh load.
  await page.reload();
  await openDocument(page, id);
  await expect(page.locator('#editor')).toHaveText('hello secret world');
  await context.close();
});

test('paste appends text and typing at the comment end stays outside', async ({ page }) => {
  const { id, editor, marked } = await createCommentedDocument(page, { text: 'before selected after', from: 7, to: 15 });
  // Paste at the document end: insertFromPaste routes through the buffered
  // replace path with the pasted plain text.
  await editor.evaluate((element) => {
    const block = element.querySelector('[data-block-id]');
    const walker = element.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let last = null;
    let node;
    while ((node = walker.nextNode())) last = node;
    const range = document.createRange();
    range.setStart(last, last.data.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', '!!');
    element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertFromPaste', dataTransfer: transfer,
    }));
  });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('before selected after!!');
  await expect(marked).toHaveText('selected');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('before selected after!!');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('selected');
});

test('IME composition inside a comment grows the comment range and persists', async ({ page }) => {
  const { id, editor, marked } = await createCommentedDocument(page, { text: '1234567890', from: 3, to: 5 });
  // The comment covers '45'. Compose between '4' and '5' (caret at marked
  // offset 1): the marked span becomes '4語5' and the range grows with it.
  // A real IME fires insertCompositionText beforeinput during the composition;
  // the editor ignores those and consumes compositionstart/end around the DOM
  // text change, which is exactly the path exercised here.
  await marked.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertCompositionText', data: '語',
    }));
    element.firstChild.data = '4語5';
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor).toHaveText('1234語567890');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('4語5');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('1234語567890');
  await expect(editor.locator('[data-annotation-families~="comment"]')).toHaveText('4語5');
});

test('a reader selection that crosses a placeholder is rejected and never edits', async ({ page, browser }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('hello secret world', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 12);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Mark confidential' }).click();
  await expect(page.locator('#status')).toHaveText('confidential span marked');

  const context = await browser.newContext();
  await context.addInitScript(() => sessionStorage.setItem('annotated-doc-view-as', 'reader'));
  const reader = await context.newPage();
  await reader.goto(origin);
  await reader.locator('.doc', { hasText: id }).click();
  await expect(reader.locator('#status')).toContainText('live', { timeout: 15000 });
  const readerEditor = reader.locator('#editor');
  await expect(readerEditor).toHaveText('hello [restricted] world');
  // A selection spanning the placeholder maps to no valid annotated-text
  // range, so the marker buttons stay disabled and no action can be applied.
  await readerEditor.evaluate((element) => {
    const block = element.querySelector('[data-block-id]');
    const walker = element.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    let offset = 0;
    const at = (target) => {
      for (const n of nodes) {
        const next = offset + n.data.length;
        if (target <= next) return [n, target - offset];
        offset = next;
      }
      throw new Error('oob');
    };
    const [sn, so] = at(2);
    const [en, eo] = at(20);
    const range = document.createRange();
    range.setStart(sn, so);
    range.setEnd(en, eo);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(reader.getByRole('button', { name: 'Add comment marker' })).toBeDisabled();
  await expect(reader.getByRole('button', { name: 'Mark confidential' })).toBeDisabled();
  // The owner's document is untouched.
  await expect(editor).toHaveText('hello secret world');
  await context.close();
});

// Build a three-run document by dispatching the paragraph-break beforeinput
// the browser sends for Enter (the demo is plaintext-only, so the input is
// driven through the same insertParagraph seam the editor listens for).
async function buildThreeRunDocument(page, editor) {
  const split = () => editor.evaluate((element) => {
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' }));
  });
  await editor.pressSequentially('aaa', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await placeCaretAtDisplay(editor, 3);
  await split();
  await expect(editor).toHaveText('aaa\n');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await placeCaretAtDisplay(editor, 4);
  await editor.pressSequentially('bbb', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await placeCaretAtDisplay(editor, 8);
  await split();
  await expect(editor).toHaveText('aaa\nbbb\n');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await placeCaretAtDisplay(editor, 9);
  await editor.pressSequentially('ccc', { delay: 0 });
  await expect(editor).toHaveText('aaa\nbbb\nccc');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
}

test('Enter creates a paragraph boundary that persists through reload', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('hello', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await placeCaretAtDisplay(editor, 2);
  await editor.evaluate((element) => {
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' }));
  });
  await expect(editor).toHaveText('he\nllo');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await expect(editor.locator('[data-run-index]')).toHaveCount(2);
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('he\nllo');
  await expect(editor.locator('[data-run-index]')).toHaveCount(2);
});

test('cut removes the selected text and the deletion persists through reload', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('abcd', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const block = element.querySelector('[data-block-id]');
    const node = element.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 1);
    range.setEnd(node, 3);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteByCut' }));
  });
  await expect(editor).toHaveText('ad');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('ad');
});

test('ordinary typing repaints only the touched run and preserves the other run nodes', async ({ page }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await buildThreeRunDocument(page, editor);
  await expect(editor.locator('[data-run-index]')).toHaveCount(3);
  await editor.evaluate(() => {
    window.__runs = [...document.querySelectorAll('[data-run-index]')];
  });
  await placeCaretAtDisplay(editor, 1);
  await editor.pressSequentially('X', { delay: 0 });
  await expect(editor).toHaveText('aXaa\nbbb\nccc');
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  const identity = await editor.evaluate(() => {
    const current = [...document.querySelectorAll('[data-run-index]')];
    return {
      count: current.length,
      sameNodes: current.length === window.__runs.length
        && current.every((element, index) => element === window.__runs[index]),
      firstRunReused: current[0] === window.__runs[0],
      firstRunText: current[0]?.textContent,
    };
  });
  expect(identity.count).toBe(3);
  expect(identity.sameNodes).toBe(true);
  expect(identity.firstRunReused).toBe(true);
  expect(identity.firstRunText).toBe('aXaa\n');
  await page.reload();
  await openDocument(page, id);
  await expect(editor).toHaveText('aXaa\nbbb\nccc');
});

// --- recipient-projected editor carets (issue #9) ---
//
// Carets are ephemeral presence projected over the live channel: the focused
// tab publishes collapsed caret offsets; a peer tab renders them as
// decorations in the caret layer (`#editor-carets`), never as placeholder
// text. A redacted reader receives only an opaque edge (`data-kind="edge"`),
// never offsets. Carets never survive reload.

test('a peer tab renders the owner caret at the typed position and clears it on blur and close', async ({ browser }) => {
  const context = await browser.newContext();
  const owner = await context.newPage();
  const id = await createDocument(owner);
  const peer = await context.newPage();
  await openDocument(peer, id);

  const ownerEditor = owner.locator('#editor');
  const peerEditor = peer.locator('#editor');
  const peerLayer = peer.locator('#editor-carets');
  const ownerBar = (offset) => peerLayer.locator(`[data-kind="caret"][data-offset="${offset}"]`);

  await ownerEditor.pressSequentially('Hello', { delay: 0 });
  await expect(ownerEditor).toHaveAttribute('aria-busy', 'false');

  // Collapse the owner caret at display offset 2 (between 'H' and 'e').
  await placeCaretAtDisplay(ownerEditor, 2);
  await owner.evaluate(() => document.dispatchEvent(new Event('selectionchange')));

  // The peer renders the owner's caret at the typed position. The peer's own
  // presence bar (published on focus, offset 0) may coexist; the owner's bar
  // is the one at offset 2.
  await expect(ownerBar('2')).toHaveCount(1, { timeout: 10000 });
  await expect(peerEditor).toHaveText('Hello');

  // Blur clears the owner's presence on the peer.
  await ownerEditor.blur();
  await expect(ownerBar('2')).toHaveCount(0, { timeout: 10000 });

  // Re-focus and republish, then close the owner page: the peer clears it.
  await ownerEditor.click();
  await placeCaretAtDisplay(ownerEditor, 2);
  await owner.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await expect(ownerBar('2')).toHaveCount(1, { timeout: 10000 });
  await owner.close();
  await expect(ownerBar('2')).toHaveCount(0, { timeout: 10000 });

  await context.close();
});

test('a redacted reader receives only edge caret presence and never offsets', async ({ page, browser }) => {
  const id = await createDocument(page);
  const editor = page.locator('#editor');
  await editor.pressSequentially('hello secret world', { delay: 0 });
  await expect(editor).toHaveAttribute('aria-busy', 'false');
  await editor.evaluate((element) => {
    const node = element.ownerDocument.createTreeWalker(element.firstElementChild, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 12);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Mark confidential' }).click();
  await expect(page.locator('#status')).toHaveText('confidential span marked');

  const context = await browser.newContext();
  await context.addInitScript(() => sessionStorage.setItem('annotated-doc-view-as', 'reader'));
  const reader = await context.newPage();
  await reader.goto(origin);
  await reader.locator('.doc', { hasText: id }).click();
  await expect(reader.locator('#status')).toContainText('live', { timeout: 15000 });
  const readerEditor = reader.locator('#editor');
  await expect(readerEditor).toHaveText('hello [restricted] world');
  const readerLayer = reader.locator('#editor-carets');

  // The reader's own focus publishes its caret back to itself as an edge,
  // which proves the reader's caret channel is subscribed before the owner
  // publishes below.
  await expect(readerLayer.locator('[data-kind="edge"]')).toHaveCount(1, { timeout: 10000 });

  // The owner publishes a collapsed caret; the reader gets only an opaque
  // edge — never an offset — and the reader's text is untouched.
  await editor.click();
  await placeCaretAtDisplay(editor, 2);
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await expect(readerLayer.locator('[data-kind="edge"]')).toHaveCount(2, { timeout: 10000 });
  await expect(readerLayer.locator('[data-kind="caret"]')).toHaveCount(0);
  await expect(readerLayer.locator('[data-offset]')).toHaveCount(0);
  await expect(readerEditor).toHaveText('hello [restricted] world');

  // Reload stability: carets are ephemeral — a reload rehydrates no presence
  // as decoration or placeholder text, and never leaks offsets.
  await reader.reload();
  await openDocument(reader, id);
  await expect(readerEditor).toHaveText('hello [restricted] world');
  await expect(readerLayer.locator('[data-kind="caret"]')).toHaveCount(0);
  await expect(readerLayer.locator('[data-offset]')).toHaveCount(0);
  // The owner's document is untouched throughout.
  await expect(editor).toHaveText('hello secret world');

  await context.close();
});
