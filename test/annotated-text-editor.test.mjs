import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { bindAnnotatedTextEditor } from '../public/workbench-client.mjs';

function visible(text, id = 'block-1') {
  return { version: 1, blocks: [{ kind: 'visible', id, text }] };
}

function setup(text = 'Hello', document = visible(text)) {
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const calls = [];
  const errors = [];
  let listener = null;
  const session = {
    document,
    history: {
      undo: async () => { calls.push(['undo']); },
      redo: async () => { calls.push(['redo']); },
    },
    replace: async (input) => { calls.push(['replace', input]); return { ok: true }; },
    subscribe(next) { listener = next; return () => { listener = null; }; },
  };
  const binding = bindAnnotatedTextEditor({ element, session, onError: (error) => errors.push(error) });
  function select(from, to = from) {
    element.focus();
    const range = dom.window.document.createRange();
    const node = element.firstChild?.firstChild;
    range.setStart(node, from);
    range.setEnd(node, to);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(range);
  }
  function selectBlock(blockId, from, to = from) {
    element.focus();
    const span = element.querySelector(`[data-block-id="${blockId}"]`);
    const range = dom.window.document.createRange();
    const node = span.firstChild;
    range.setStart(node, from); range.setEnd(node, to);
    dom.window.getSelection().removeAllRanges(); dom.window.getSelection().addRange(range);
  }
  function beforeinput(inputType, data = null, extras = {}) {
    const event = new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data, ...extras });
    element.dispatchEvent(event);
    return event;
  }
  return { dom, element, session, calls, errors, binding, select, selectBlock, beforeinput, publish(document) { session.document = document; listener?.(document); } };
}

const flushInput = () => new Promise((resolve) => setTimeout(resolve, 110));

test('annotated editor replaces a selection within one block', async () => {
  const harness = setup();
  assert.equal(harness.element.textContent, 'Hello');
  harness.select(1, 4);
  const event = harness.beforeinput('insertText', 'i');
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.element.textContent, 'Hio');
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { blockId: 'block-1', offset: 1, affinity: 'right' },
    to: { blockId: 'block-1', offset: 4, affinity: 'right' },
    text: 'i',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor backspace and forward delete preserve surrogate pairs', async () => {
  const backward = setup('a😀b');
  backward.select(3);
  backward.beforeinput('deleteContentBackward');
  await flushInput();
  assert.deepEqual(backward.calls[0][1], {
    from: { blockId: 'block-1', offset: 1, affinity: 'right' },
    to: { blockId: 'block-1', offset: 3, affinity: 'right' },
    text: '',
  });
  backward.binding.close();

  const forward = setup('a😀b');
  forward.select(1);
  forward.beforeinput('deleteContentForward');
  await flushInput();
  assert.deepEqual(forward.calls[0][1], {
    from: { blockId: 'block-1', offset: 1, affinity: 'right' },
    to: { blockId: 'block-1', offset: 3, affinity: 'right' },
    text: '',
  });
  forward.binding.close();
});

test('annotated editor deletes into an adjacent block at a collapsed block boundary', async () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'before', text: '12' },
    { kind: 'visible', id: 'comment', text: '34' },
    { kind: 'visible', id: 'after', text: '56' },
  ] };
  const backward = setup('', document);
  backward.selectBlock('comment', 0);
  backward.beforeinput('deleteContentBackward');
  await flushInput();
  assert.deepEqual(backward.calls[0][1], {
    from: { blockId: 'before', offset: 1, affinity: 'right' },
    to: { blockId: 'before', offset: 2, affinity: 'right' },
    text: '',
  });
  backward.binding.close();

  const forward = setup('', document);
  forward.selectBlock('comment', 2);
  forward.beforeinput('deleteContentForward');
  await flushInput();
  assert.deepEqual(forward.calls[0][1], {
    from: { blockId: 'after', offset: 0, affinity: 'right' },
    to: { blockId: 'after', offset: 1, affinity: 'right' },
    text: '',
  });
  forward.binding.close();
});

test('annotated editor deletes to the start of the line for soft and hard line backward input', async () => {
  for (const inputType of ['deleteSoftLineBackward', 'deleteHardLineBackward']) {
    const harness = setup('a\nb');
    harness.select(3);
    harness.beforeinput(inputType);
    await flushInput();
    assert.deepEqual(harness.calls[0][1], {
      from: { blockId: 'block-1', offset: 2, affinity: 'right' },
      to: { blockId: 'block-1', offset: 3, affinity: 'right' },
      text: '',
    });
    harness.binding.close();

    const emoji = setup('a\n😀b');
    emoji.select(5);
    emoji.beforeinput(inputType);
    await flushInput();
    assert.deepEqual(emoji.calls[0][1], {
      from: { blockId: 'block-1', offset: 2, affinity: 'right' },
      to: { blockId: 'block-1', offset: 5, affinity: 'right' },
      text: '',
    });
    emoji.binding.close();

    const lineStart = setup('a\nb');
    lineStart.select(2);
    lineStart.beforeinput(inputType);
    await flushInput();
    assert.deepEqual(lineStart.calls, []);
    lineStart.binding.close();
  }
});

test('annotated editor commits composition once and delegates history', async () => {
  const harness = setup('ab');
  harness.select(1);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.element.firstChild.textContent = 'a語b';
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  await Promise.resolve();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0][0], 'replace');
  assert.deepEqual(harness.calls[0][1], {
    from: { blockId: 'block-1', offset: 1, affinity: 'right' },
    to: { blockId: 'block-1', offset: 1, affinity: 'right' },
    text: '語',
  });
  harness.beforeinput('historyUndo');
  harness.beforeinput('historyRedo');
  assert.deepEqual(harness.calls.slice(1), []);
  assert.match(harness.errors.at(-1).message, /history is unavailable/);
  harness.binding.close();
});

test('annotated editor clears busy state after an unchanged composition', () => {
  const harness = setup('Hello');
  harness.select(5);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true }));

  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.deepEqual(harness.calls, []);
  harness.binding.close();
});

test('annotated editor accepts a foreign update during an unchanged composition', () => {
  const harness = setup('Hello');
  harness.select(5);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.publish(visible('Hello!'));
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true }));

  assert.equal(harness.element.textContent, 'Hello!');
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor rebases compatible buffered insertion over a foreign append', async () => {
  const harness = setup('ab');
  harness.select(1);
  harness.beforeinput('insertText', 'X');
  harness.publish(visible('ab!'));
  assert.equal(harness.element.textContent, 'aXb!');
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { blockId: 'block-1', offset: 1, affinity: 'right' },
    to: { blockId: 'block-1', offset: 1, affinity: 'right' },
    text: 'X',
  });
  harness.binding.close();
});

test('annotated editor preserves later typing while the preceding replacement settles', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settlements.push(resolve); }) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  assert.equal(harness.calls.length, 1);
  harness.element.focus();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  await flushInput();
  assert.equal(harness.element.textContent, 'abc');
  assert.equal(harness.calls.length, 1, 'later input remains buffered while the first replacement settles');
  // The package session projects the first replacement before its receipt settles.
  harness.publish(visible('ab'));
  settlements.shift()();
  await flushInput();
  assert.deepEqual(harness.calls[1][1], {
    from: { blockId: 'block-1', offset: 2, affinity: 'right' },
    to: { blockId: 'block-1', offset: 2, affinity: 'right' },
    text: 'c',
  });
  harness.element.focus();
  harness.select(3);
  harness.beforeinput('insertText', 'd');
  await flushInput();
  assert.equal(harness.element.textContent, 'abcd');
  assert.equal(harness.calls.length, 2, 'the second in-flight draft remains the baseline for later input');
  harness.publish(visible('abc'));
  settlements.shift()();
  await flushInput();
  assert.deepEqual(harness.calls[2][1], {
    from: { blockId: 'block-1', offset: 3, affinity: 'right' },
    to: { blockId: 'block-1', offset: 3, affinity: 'right' },
    text: 'd',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor waits for receipt ingest before flushing a queued successor', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => settlements.push(resolve)) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  await flushInput();
  settlements.shift()();
  await flushInput();
  assert.equal(harness.element.textContent, 'abc');
  assert.equal(harness.element.getAttribute('aria-busy'), 'true');
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.errors, []);

  harness.publish(visible('ab'));
  await flushInput();
  assert.deepEqual(harness.calls[1][1], {
    from: { blockId: 'block-1', offset: 2, affinity: 'right' },
    to: { blockId: 'block-1', offset: 2, affinity: 'right' },
    text: 'c',
  });
  harness.publish(visible('abc'));
  settlements.shift()();
  await flushInput();
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  harness.binding.close();
});

test('annotated editor folds queued typing into one composition replacement', async () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.element.firstChild.textContent = 'ab語';
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  await Promise.resolve();

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0][1], {
    from: { blockId: 'block-1', offset: 1, affinity: 'right' },
    to: { blockId: 'block-1', offset: 1, affinity: 'right' },
    text: 'b語',
  });
  harness.binding.close();
});

test('annotated editor rebases queued typing and composition over a compatible foreign append', () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.publish(visible('ac'));
  harness.element.firstChild.textContent = 'ab語';
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));

  assert.equal(harness.element.textContent, 'ab語c');
  assert.deepEqual(harness.calls[0][1], {
    from: { blockId: 'block-1', offset: 1, affinity: 'right' },
    to: { blockId: 'block-1', offset: 1, affinity: 'right' },
    text: 'b語',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor reports an incompatible update after queued composition instead of dropping it', () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.publish(visible('foreign replacement'));
  harness.element.firstChild.textContent = 'ab語';
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));

  assert.equal(harness.element.textContent, 'foreign replacement');
  assert.match(harness.errors.at(-1).message, /changed before buffered input/);
  harness.binding.close();
});

test('annotated editor blocks history while queued and permits retry after ingest', async () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  harness.beforeinput('historyUndo');
  assert.deepEqual(harness.calls, []);

  await flushInput();
  harness.publish(visible('ab'));
  await flushInput();
  harness.beforeinput('historyUndo');
  await Promise.resolve();
  assert.deepEqual(harness.calls.slice(1), [['undo']]);
  harness.binding.close();
});

test('annotated editor blocks keydown history while local work is pending', async () => {
  const harness = setup('a');
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  const event = new harness.dom.window.KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, key: 'z', ctrlKey: true,
  });
  harness.element.dispatchEvent(event);
  await Promise.resolve();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.calls, []);
  assert.match(harness.errors.at(-1).message, /history is unavailable/);
  harness.binding.close();
});

test('annotated editor queues composition behind a submitted replacement', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => settlements.push(resolve)) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.select(2);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.element.firstChild.textContent = 'ab語';
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  await flushInput();

  assert.equal(harness.element.textContent, 'ab語');
  assert.equal(harness.calls.length, 1, 'composition waits for the submitted replacement to ingest');
  harness.publish(visible('ab'));
  settlements.shift()();
  await flushInput();
  assert.deepEqual(harness.calls[1][1], {
    from: { blockId: 'block-1', offset: 2, affinity: 'right' },
    to: { blockId: 'block-1', offset: 2, affinity: 'right' },
    text: '語',
  });
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor reports an incompatible foreign update after submitted input ingests', async () => {
  const harness = setup('a');
  const settlements = [];
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settlements.push(resolve); }) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.publish(visible('ab'));
  settlements.shift()();
  await flushInput();
  harness.element.focus();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  harness.publish(visible('foreign replacement'));

  assert.equal(harness.element.textContent, 'foreign replacement');
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.match(harness.errors.at(-1).message, /changed before buffered input/);
  harness.binding.close();
});

test('annotated editor discards buffered successor after its predecessor is rejected', async () => {
  const harness = setup('a');
  let reject;
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return new Promise((resolve) => { reject = resolve; });
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.element.focus();
  harness.select(2);
  harness.beforeinput('insertText', 'c');
  reject({ ok: false, failure: new Error('replacement rejected') });
  await flushInput();

  assert.equal(harness.element.textContent, 'a');
  assert.match(harness.errors.at(-1).message, /replacement rejected/);
  harness.binding.close();
});

test('annotated editor submits new input from a foreign snapshot after its predecessor settles', async () => {
  const harness = setup('a');
  let settle;
  harness.session.status = 'live';
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settle = resolve; }) } };
  };
  harness.select(1);
  harness.beforeinput('insertText', 'b');
  await flushInput();
  harness.publish(visible('foreign'));
  harness.element.focus();
  harness.select(7);
  harness.beforeinput('insertText', '!');
  settle();
  await flushInput();

  assert.deepEqual(harness.calls[1][1], {
    from: { blockId: 'block-1', offset: 7, affinity: 'right' },
    to: { blockId: 'block-1', offset: 7, affinity: 'right' },
    text: '!',
  });
  harness.binding.close();
});

test('annotated editor conflict errors never include buffered or document text', () => {
  const harness = setup('private document text');
  harness.select(1);
  harness.beforeinput('insertText', 'secret buffered text');
  harness.publish(visible('incompatible replacement'));

  assert.equal(harness.errors[0].message, 'annotated text changed before buffered input was submitted');
  assert.doesNotMatch(harness.errors[0].message, /private|secret|replacement/);
  harness.binding.close();
});

test('annotated editor renders ordered visible and restricted blocks as keyed spans', () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'restricted', id: 'secret', placeholder: '[restricted]' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  assert.deepEqual([...harness.element.children].map((span) => [span.dataset.blockId, span.textContent]), [
    ['left', 'Left'], ['secret', '[restricted]'], ['right', 'Right'],
  ]);
  assert.equal(harness.element.querySelector('[data-block-id="secret"]').contentEditable, 'false');
  harness.binding.close();
});

test('annotated editor exposes visible annotation families and identities on their block spans', () => {
  const document = {
    version: 1,
    blocks: [{ kind: 'visible', id: 'marked', text: 'marked', annotationIds: ['comment-1'] }],
    annotations: [{ id: 'comment-1', family: 'comment', fields: {} }],
  };
  const harness = setup('', document);

  assert.equal(
    harness.element.querySelector('[data-block-id="marked"]').dataset.annotationFamilies,
    'comment',
  );
  assert.equal(
    harness.element.querySelector('[data-block-id="marked"]').dataset.annotationIds,
    'comment-1',
  );
  harness.binding.close();
});

test('annotated editor routes middle and right edits with local offsets', async () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'visible', id: 'middle', text: 'Middle' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  harness.selectBlock('middle', 2);
  harness.beforeinput('insertText', 'X');
  await flushInput();
  harness.publish({ version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'visible', id: 'middle', text: 'MiXddle' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] });
  harness.selectBlock('right', 1);
  harness.beforeinput('deleteContentBackward');
  await flushInput();
  assert.equal(harness.calls[0][1].from.blockId, 'middle');
  assert.equal(harness.calls[0][1].from.offset, 2);
  assert.equal(harness.calls[1][1].from.blockId, 'right');
  assert.deepEqual(harness.calls[1][1].from, { blockId: 'right', offset: 0, affinity: 'right' });
  harness.binding.close();
});

test('annotated editor maps selections and rejects cross-block replacement without mutation', () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  harness.selectBlock('right', 2, 4);
  assert.deepEqual(harness.binding.getSelection(), { from: { blockId: 'right', offset: 2, affinity: 'right' }, to: { blockId: 'right', offset: 4, affinity: 'right' } });
  const range = harness.dom.window.document.createRange();
  range.setStart(harness.element.querySelector('[data-block-id="left"]').firstChild, 1);
  range.setEnd(harness.element.querySelector('[data-block-id="right"]').firstChild, 2);
  const selection = harness.dom.window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  const before = harness.element.innerHTML;
  harness.beforeinput('insertText', 'nope');
  assert.equal(harness.element.innerHTML, before);
  assert.deepEqual(harness.calls, []);
  assert.match(harness.errors[0].message, /not yet supported atomically/);
  harness.binding.close();
});

test('annotated editor maps a span boundary to the end of that block', () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  const span = harness.element.querySelector('[data-block-id="left"]');
  const range = harness.dom.window.document.createRange();
  range.setStart(span, span.childNodes.length);
  range.collapse(true);
  const selection = harness.dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  assert.deepEqual(harness.binding.getSelection(), {
    from: { blockId: 'left', offset: 4, affinity: 'right' },
    to: { blockId: 'left', offset: 4, affinity: 'right' },
  });
  harness.binding.close();
});

test('annotated editor rejects selections touching restricted spans, including root boundaries', () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'restricted', id: 'secret', placeholder: '[restricted]' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  const left = harness.element.querySelector('[data-block-id="left"]');
  const right = harness.element.querySelector('[data-block-id="right"]');
  const secret = harness.element.querySelector('[data-block-id="secret"]');
  const selection = harness.dom.window.getSelection();
  const range = harness.dom.window.document.createRange();

  range.setStart(left.firstChild, 4); range.setEnd(right.firstChild, 0);
  selection.removeAllRanges(); selection.addRange(range);
  assert.equal(harness.binding.getSelection(), null);
  range.setStart(harness.element, 1); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  assert.equal(harness.binding.getSelection(), null);
  range.setStart(secret, 0); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  assert.equal(harness.binding.getSelection(), null);
  harness.binding.close();
});

test('annotated editor fails closed when another block is edited while one is pending', async () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  harness.selectBlock('left', 4);
  harness.beforeinput('insertText', '!');
  harness.selectBlock('right', 5);
  const before = harness.element.innerHTML;
  const event = harness.beforeinput('insertText', '?');
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.element.innerHTML, before);
  assert.equal(harness.calls.length, 0);
  assert.match(harness.errors.at(-1).message, /another block/);
  harness.binding.close();
});

test('annotated editor reverts cross-block composition while another block is pending', () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  harness.selectBlock('left', 4);
  harness.beforeinput('insertText', '!');
  harness.selectBlock('right', 2, 4);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true, cancelable: true }));
  harness.element.querySelector('[data-block-id="right"]').firstChild.textContent = 'R語ght';
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '語' }));
  assert.equal(harness.element.textContent, 'Left!Right');
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0][1].from.blockId, 'left');
  harness.binding.close();
});

test('annotated editor preserves a buffered block when another block changes', () => {
  const document = { version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Left' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] };
  const harness = setup('', document);
  harness.selectBlock('right', 5);
  harness.beforeinput('insertText', '!');
  harness.publish({ version: 1, blocks: [
    { kind: 'visible', id: 'left', text: 'Changed' },
    { kind: 'visible', id: 'right', text: 'Right' },
  ] });

  assert.equal(harness.element.textContent, 'ChangedRight!');
  assert.deepEqual(harness.errors, []);
  harness.binding.close();
});

test('annotated editor fails closed when its buffered block disappears', () => {
  const harness = setup('Right');
  harness.select(5);
  harness.beforeinput('insertText', '!');
  harness.publish({ version: 1, blocks: [{ kind: 'visible', id: 'replacement', text: 'Other' }] });

  assert.equal(harness.element.textContent, 'Other');
  assert.equal(harness.element.getAttribute('aria-busy'), 'false');
  assert.match(harness.errors[0].message, /changed before buffered input/);
  harness.binding.close();
});

function annotatedDocument() {
  return {
    version: 1,
    blocks: [
      { kind: 'visible', id: 'b1', text: 'ab', annotationIds: ['ann-1'] },
      { kind: 'visible', id: 'b2', text: 'cd', annotationIds: ['ann-1', 'ann-2'] },
      { kind: 'visible', id: 'b3', text: 'ef' },
    ],
    annotations: [
      { id: 'ann-1', family: 'comment' },
      { id: 'ann-2', family: 'comment' },
    ],
  };
}

test('annotated editor follows insert-block when boundary typing leaves the annotated block', async () => {
  const marked = {
    version: 1,
    blocks: [
      { kind: 'visible', id: 'prefix', text: '12345678' },
      { kind: 'visible', id: 'marked', text: '90', annotationIds: ['comment-1'] },
    ],
    annotations: [{ id: 'comment-1', family: 'comment', fields: {} }],
  };
  const harness = setup('', marked);
  harness.session.status = 'live';
  let settle;
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settle = resolve; }) } };
  };

  harness.selectBlock('marked', 2);
  harness.beforeinput('insertText', 'x');
  assert.equal(harness.element.textContent, '1234567890x');
  await flushInput();
  assert.deepEqual(harness.calls[0][1], {
    from: { blockId: 'marked', offset: 2, affinity: 'right' },
    to: { blockId: 'marked', offset: 2, affinity: 'right' },
    text: 'x',
  });

  harness.publish({
    version: 1,
    blocks: [
      { kind: 'visible', id: 'prefix', text: '12345678' },
      { kind: 'visible', id: 'marked', text: '90', annotationIds: ['comment-1'] },
      { kind: 'visible', id: 'after', text: 'x' },
    ],
    annotations: [{ id: 'comment-1', family: 'comment', fields: {} }],
  });
  settle();
  await flushInput();

  assert.deepEqual(harness.errors, []);
  assert.equal(harness.element.textContent, '1234567890x');
  assert.equal(harness.element.querySelector('[data-block-id="marked"]').textContent, '90');
  assert.equal(harness.element.querySelector('[data-block-id="after"]').textContent, 'x');
  assert.deepEqual(harness.binding.getSelection(), {
    from: { blockId: 'after', offset: 1, affinity: 'right' },
    to: { blockId: 'after', offset: 1, affinity: 'right' },
  });

  harness.beforeinput('insertText', 'y');
  await flushInput();
  assert.deepEqual(harness.errors, []);
  assert.equal(harness.calls[1][1].from.blockId, 'after');
  assert.equal(harness.calls[1][1].text, 'y');
  harness.binding.close();
});

test('annotated editor follows insert-block before an annotated block', async () => {
  const marked = {
    version: 1,
    blocks: [
      { kind: 'visible', id: 'marked', text: '34', annotationIds: ['comment-1'] },
    ],
    annotations: [{ id: 'comment-1', family: 'comment', fields: {} }],
  };
  const harness = setup('', marked);
  harness.session.status = 'live';
  let settle;
  harness.session.replace = async (input) => {
    harness.calls.push(['replace', input]);
    return { ok: true, settlement: { wait: () => new Promise((resolve) => { settle = resolve; }) } };
  };

  harness.selectBlock('marked', 0);
  harness.beforeinput('insertText', 'L');
  await flushInput();
  harness.publish({
    version: 1,
    blocks: [
      { kind: 'visible', id: 'before', text: 'L' },
      { kind: 'visible', id: 'marked', text: '34', annotationIds: ['comment-1'] },
    ],
    annotations: [{ id: 'comment-1', family: 'comment', fields: {} }],
  });
  settle();
  await flushInput();

  assert.deepEqual(harness.errors, []);
  assert.equal(harness.element.textContent, 'L34');
  assert.deepEqual(harness.binding.getSelection()?.from.blockId, 'before');
  harness.binding.close();
});

test('setAnnotationHighlight toggles data-active-annotation on matching spans only', () => {
  const harness = setup('', annotatedDocument());
  const b1 = harness.element.querySelector('[data-block-id="b1"]');
  const b2 = harness.element.querySelector('[data-block-id="b2"]');
  const b3 = harness.element.querySelector('[data-block-id="b3"]');

  harness.binding.setAnnotationHighlight('ann-1', true);
  assert.equal(b1.dataset.activeAnnotation, 'true');
  assert.equal(b2.dataset.activeAnnotation, 'true');
  assert.equal(b3.hasAttribute('data-active-annotation'), false);

  harness.binding.setAnnotationHighlight('ann-1', false);
  assert.equal(b1.hasAttribute('data-active-annotation'), false);
  assert.equal(b2.hasAttribute('data-active-annotation'), false);
  assert.equal(b3.hasAttribute('data-active-annotation'), false);
  harness.binding.close();
});

test('setAnnotationHighlight is a no-op for an unknown annotation id', () => {
  const harness = setup('', annotatedDocument());
  const before = harness.element.innerHTML;
  harness.binding.setAnnotationHighlight('missing', true);
  assert.equal(harness.element.innerHTML, before);
  harness.binding.close();
});

test('selectAnnotation selects the contiguous range across all matching spans', () => {
  const harness = setup('', annotatedDocument());
  harness.binding.selectAnnotation('ann-1');
  const selection = harness.dom.window.getSelection();
  assert.equal(selection.rangeCount, 1);
  const range = selection.getRangeAt(0);
  const b1 = harness.element.querySelector('[data-block-id="b1"]');
  const b2 = harness.element.querySelector('[data-block-id="b2"]');
  assert.equal(range.startContainer, b1.firstChild);
  assert.equal(range.startOffset, 0);
  assert.equal(range.endContainer, b2.firstChild);
  assert.equal(range.endOffset, b2.firstChild.data.length);
  assert.equal(harness.element.ownerDocument.activeElement, harness.element);
  harness.binding.close();
});

test('selectAnnotation is a no-op for an unknown annotation id', () => {
  const harness = setup('', annotatedDocument());
  harness.element.focus();
  const selection = harness.dom.window.getSelection();
  selection.removeAllRanges();
  harness.binding.selectAnnotation('missing');
  assert.equal(selection.rangeCount, 0);
  harness.binding.close();
});

test('annotation helpers fail closed after close', () => {
  const harness = setup('', annotatedDocument());
  const b1 = harness.element.querySelector('[data-block-id="b1"]');
  harness.binding.close();
  harness.binding.setAnnotationHighlight('ann-1', true);
  assert.equal(b1.hasAttribute('data-active-annotation'), false);
  harness.binding.selectAnnotation('ann-1');
  assert.equal(harness.dom.window.getSelection().rangeCount, 0);
});
