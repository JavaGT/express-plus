import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { bindAnnotatedTextEditor } from '../public/workbench-client.mjs';

function visible(text, id = 'block-1') {
  return { version: 1, blocks: [{ kind: 'visible', id, text }] };
}

function setup(text = 'Hello') {
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const calls = [];
  const errors = [];
  let listener = null;
  const session = {
    document: visible(text),
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
    const node = element.firstChild;
    range.setStart(node, from);
    range.setEnd(node, to);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(range);
  }
  function beforeinput(inputType, data = null, extras = {}) {
    const event = new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data, ...extras });
    element.dispatchEvent(event);
    return event;
  }
  return { dom, element, session, calls, errors, binding, select, beforeinput, publish(document) { session.document = document; listener?.(document); } };
}

const flushInput = () => new Promise((resolve) => setTimeout(resolve, 35));

test('annotated editor rejects non-atomic selection replacement without changing visible text', async () => {
  const harness = setup();
  assert.equal(harness.element.textContent, 'Hello');
  harness.select(1, 4);
  const event = harness.beforeinput('insertText', 'i');
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.element.textContent, 'Hello');
  assert.deepEqual(harness.calls, []);
  assert.match(harness.errors[0].message, /not yet supported atomically/);
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

test('annotated editor commits composition once and delegates history', async () => {
  const harness = setup('ab');
  harness.select(1);
  harness.element.dispatchEvent(new harness.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  harness.element.textContent = 'a語b';
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
  await Promise.resolve();
  assert.deepEqual(harness.calls.slice(1), [['undo'], ['redo']]);
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

test('annotated editor conflict errors never include buffered or document text', () => {
  const harness = setup('private document text');
  harness.select(1);
  harness.beforeinput('insertText', 'secret buffered text');
  harness.publish(visible('incompatible replacement'));

  assert.equal(harness.errors[0].message, 'annotated text changed before buffered input was submitted');
  assert.doesNotMatch(harness.errors[0].message, /private|secret|replacement/);
  harness.binding.close();
});
